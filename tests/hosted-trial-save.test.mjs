// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { saveFixture, api } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const merge = await import(moduleUrl('../convex/projectHostedConflictMerge.ts'));
const base = 'one\ntwo\nthree\nfour\nfive\n';
const mine = 'one\nMINE\nthree\nfour\nfive\n';
const peerText = 'one\nPEER\nthree\nfour\nfive\n';

async function peer(s, path = 'a.txt') {
  const pin = s.put(peerText),
    laneId = randomUUID();
  const head = s.put(
    JSON.stringify({
      ...s.state,
      parents: [s.baseline.sha256],
      files: s.state.files
        .filter(file => file.path !== path)
        .concat({ path, blob: pin.sha256, mode: 'file' })
        .sort((a, b) => a.path.localeCompare(b.path)),
    }),
  );
  await s.run('seedPeer', (ctx, input) => records.writeHostedRecord(ctx, input), {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    record: {
      kind: 'lane',
      id: laneId,
      intentId: randomUUID(),
      actor: 'owner',
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      authorityEpoch: 1,
      at: s.state.at,
      base: { head: s.baseline.sha256, receiptId: 'main-0' },
      head: head.sha256,
      state: 'active',
    },
    overlap: {
      baseSequence: 0,
      intent: 'synthetic peer',
      complete: true,
      changes: [
        {
          path,
          before: path === 'a.txt' ? { blob: s.original.sha256, mode: 'file' } : null,
          after: { blob: pin.sha256, mode: 'file' },
        },
      ],
    },
  });
  return laneId;
}
function r2(t, s) {
  const keys = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const before = keys.map(key => [key, process.env[key]]);
  for (const key of keys) process.env[key] = 'synthetic';
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(globalThis, 'fetch', async url => {
    const bytes = s.objects.get(new URL(url).pathname.split('/o/')[1]);
    return new Response(bytes ?? null, { status: bytes ? 200 : 404 });
  });
}
const progress = async (s, x) =>
  JSON.parse(
    await s.call('progress', api.progress, { projectId: s.projectId, operationId: x.request.operationId }),
  );
async function trial(s, task) {
  await merge.run._handler(
    {
      runMutation: (ref, args) => {
        assert.equal(getFunctionName(ref), 'projectHostedConflicts:record');
        return s.call('trialRecord', conflicts.record, args);
      },
      runQuery: async () => null,
    },
    task.args,
  );
}

test('83e6d0d3: a dead or retried advisory trial cannot strand save publication or its waiter', async t => {
  const s = await saveFixture(base),
    peerId = await peer(s);
  r2(t, s);
  const x = await s.prepare([s.change(mine)]);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  const terminal = await s.publish(output);
  assert.equal(terminal.outcome.status, 'completed');
  assert.deepEqual((await progress(s, x)).terminal, terminal, 'publication never waits for the action');
  const pending = s.scheduled.filter(task => task.name === 'projectHostedConflictMerge:run');
  assert.equal(pending.length, 1, 'one action plus its existing record mutation');
  // Simulate a process dying before record, then a lost reply from the save's publisher.
  assert.deepEqual(await s.submit(x), terminal);
  assert.deepEqual(await s.publish(output), terminal);
  assert.equal(s.scheduled.filter(task => task.name === 'projectHostedConflictMerge:run').length, 1);
  await trial(s, pending[0]);
  const notice = [...s.tables.projectHostedConflictNotices.values()].find(row => row.laneId === s.laneId);
  assert.equal(notice.peer, peerId);
  assert.deepEqual(notice.paths[0].mine, [[2, 2]]);
  const inboxes = structuredClone([...s.tables.projectBoardInboxes.values()]);
  await trial(s, pending[0]);
  assert.equal(s.tables.projectHostedConflictNotices.size, 2, 'one notice per side on retry');
  assert.deepEqual([...s.tables.projectBoardInboxes.values()], inboxes, 'retry does not rewake either agent');
  assert.equal(s.counts.at(-1).writes, 0);
  assert.deepEqual((await progress(s, x)).terminal, terminal);
});

test('83e6d0d3: unchanged saves stay immediately terminal and schedule no redundant advisory trial', async () => {
  const s = await saveFixture(base),
    x = await s.prepare([s.change(mine)]);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  assert.equal((await s.publish(output)).outcome.status, 'completed');
  await peer(s);
  const clean = await s.prepare([], {
    expected: { ...s.expected, head: output.head, version: 1, sourceVersion: 1 },
  });
  assert.equal((await s.submit(clean)).outcome.result.unchanged, true);
  assert.equal((await progress(s, clean)).terminal.outcome.status, 'completed');
  assert.equal(s.scheduled.filter(task => task.name === 'projectHostedConflictMerge:run').length, 0);
});

test('83e6d0d3: a disjoint save adds zero trial calls or inbox work', async () => {
  const s = await saveFixture(base);
  await peer(s, 'other.txt');
  const x = await s.prepare([s.change(mine)]);
  await s.stage(x);
  await s.submit(x);
  assert.equal((await s.publish(await s.work(x))).outcome.status, 'completed');
  assert.equal(s.scheduled.filter(task => task.name === 'projectHostedConflictMerge:run').length, 0);
  assert.equal(s.tables.projectBoardInboxes.size, 0);
  assert.equal(s.tables.projectBoardProjects.size, 0);
  assert.equal(s.tables.projectHostedConflictNotices.size, 0);
});
