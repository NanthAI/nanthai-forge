// SPDX-License-Identifier: Apache-2.0
// Split save (fea47345 C): a save returns once its upload is in and it is submitted; the server
// settles it on a scheduled step, peers see its paths at once, and the checkout's next command
// applies the outcome or reports a failed settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { controls, environment } from './hosted-source-efficiency-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { saveHostedLane, settleBackgroundSave } from '../dist/hosted-save-client.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';

const contract = {
  overlapEvidence: false,
  submitPage: true,
  submitRun: true,
  prepareTargets: true,
  runPublish: true,
  settleBackground: true,
  durations: true,
};

async function setup(t, { fromBase = false } = {}) {
  environment(t);
  process.env.FORGE_SOURCE_PROVIDER = 'convex';
  const s = await composeFixture();
  const files = Array.from({ length: 20 }, (_, i) =>
    s.file(`f${String(i).padStart(2, '0')}`, `original-${i}\n`),
  );
  const baseline = fromBase ? s.baseline : s.state(files),
    entry = await s.lane(baseline),
    state = JSON.parse(s.objects.get(baseline.sha256));
  const directory = mkdtempSync(join(tmpdir(), 'forge-settle-background-')),
    root = join(directory, 'checkout');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: entry.laneId,
        intentId: s.intentId,
        head: entry.head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state,
      scope: [],
      materialized: state.files.map(file => file.path),
    }),
  );
  for (const file of state.files) writeFileSync(join(root, file.path), s.objects.get(file.blob));
  const changed = state.files.slice(0, 2).map(file => file.path);
  for (const path of changed) writeFileSync(join(root, path), `changed-${path}\n`);
  // The submit's scheduled work, recorded instead of run: the test runs it when it chooses.
  const scheduled = [];
  const decorate = s.decorateContext.bind(s);
  s.decorateContext = fn =>
    decorate(async (ctx, ...rest) => {
      await fn(ctx, ...rest);
      ctx.scheduler = {
        runAfter: async (ms, ref, args) => {
          scheduled.push({ ms, name: getFunctionName(ref), args });
          return 'synthetic-task';
        },
        cancel: async () => {},
      };
    });
  const c = controls(t, s);
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  const exchange = new ConvexExchange(
    'https://fixture.invalid',
    'synthetic',
    s.projectId,
    randomUUID(),
    null,
  );
  exchange.client = c.client;
  const overlap = () =>
    [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === entry.laneId);
  const settle = async jobId => {
    const args = { projectId: s.projectId, jobId };
    await c.call('projectConvexSource:dispatch', args);
    await c.call('projectConvexSource:step', { ...args, step: 0 });
    await c.call('projectHostedSaveJobs:complete', args);
  };
  return { s, c, root, entry, exchange, scheduled, overlap, settle, changed, files: state.files.length };
}
const count = (calls, name) => calls.filter(value => value === name).length;

for (const fromBase of [false, true])
  test(`a split save returns after its upload, peers see its paths at once, and the next command applies the settle with one read${fromBase ? ' (first save from the base)' : ''}`, async t => {
    const f = await setup(t, { fromBase });
    const command = { operationId: randomUUID(), message: 'split save' };
    const before = f.c.calls.length;
    const returned = await saveHostedLane(f.root, command, f.exchange, contract);
    const saveCalls = f.c.calls.slice(before);
    assert.equal(returned.status, 'submitted', 'the save returned before its settle');
    assert.equal(returned.outcome, undefined);
    assert.equal(count(saveCalls, 'projectSourceRun:submit'), 1);
    assert.equal(count(saveCalls, 'projectConvexSourceStore:commit'), 0, 'no step ran inside the save');
    const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
    assert.equal(dispatch?.ms, 0, 'the settle is scheduled at once');
    // Peers (and this Lane's own overlap read) see the save's paths before its head is published.
    const row = f.overlap();
    assert.equal(row.head, f.entry.head);
    assert.deepEqual(
      JSON.parse(row.changes)
        .map(change => change.path)
        .sort(),
      f.changed,
    );
    assert.equal(
      readHostedLaneCheckout(f.root).selection.head,
      f.entry.head,
      'the marker waits for the outcome',
    );

    await f.settle(returned.jobId);
    const next = f.c.calls.length;
    if (fromBase) {
      // A direct read (no capability call to carry it): one progress read applies the settle.
      await settleBackgroundSave(f.root, f.exchange);
      assert.deepEqual(f.c.calls.slice(next), ['projectHostedSaves:progress'], 'one read applies the settle');
    } else {
      // The agent's next command: its capability call carries the outcome, so no read is added.
      const agent = new HostedAgentTransport(
        f.root,
        { url: 'https://fixture.invalid', projectId: f.s.projectId },
        f.exchange,
      );
      await agent.dispatch('status', {}).catch(error => assert.notEqual(error.code, 'SAVE_SETTLE_FAILED'));
      assert.equal(f.c.calls[next], 'projectHostedAgent:capabilities');
      assert.equal(count(f.c.calls.slice(next), 'projectHostedSaves:progress'), 0);
    }
    const marker = readHostedLaneCheckout(f.root);
    assert.notEqual(marker.selection.head, f.entry.head);
    assert.equal(marker.selection.version, 1);
    assert.equal(JSON.parse(f.s.objects.get(marker.selection.head)).files.length, f.files);
    assert.equal(f.overlap().head, marker.selection.head, 'the publish keeps the same paths on the new head');
    assert.equal(existsSync(join(clientCacheRoot(f.root), `saves/${command.operationId}/background`)), false);
    // Settled: later commands make no call for it (idle costs nothing).
    const idle = f.c.calls.length;
    await settleBackgroundSave(f.root, f.exchange);
    assert.equal(f.c.calls.length, idle);
  });

test('a settle that fails after the save returned is reported by the next command, once', async t => {
  const f = await setup(t);
  const command = { operationId: randomUUID(), message: 'split save' };
  const returned = await saveHostedLane(f.root, command, f.exchange, contract);
  assert.equal(returned.status, 'submitted');
  // Another writer moves the Lane before the scheduled settle publishes: the settle fails WORK_STALE.
  const head = [...f.s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'lane' && row.key === f.entry.laneId,
  );
  const record = f.s.tables.projectHostedRecords.get(head.recordId);
  const bodies = Object.entries(f.s.tables).find(([, rows]) => rows.has(record.bodyId));
  const value = JSON.stringify({ ...JSON.parse(bodies[1].get(record.bodyId).value), sourceVersion: 7 });
  f.s.patch(bodies[0], record.bodyId, { value });
  f.s.patch('projectHostedRecords', record._id, {
    digest: digest(value),
    bytes: Buffer.byteLength(value),
  });
  await f.settle(returned.jobId);
  const progress = JSON.parse(
    await f.c.client.query(makeFunctionReference('projectHostedSaves:progress'), {
      projectId: f.s.projectId,
      operationId: command.operationId,
    }),
  );
  assert.equal(progress.terminal.outcome.status, 'failed', 'the server could not finish the save');

  // The agent's next command, whatever it is (here a read), reports it before doing anything else.
  const agent = new HostedAgentTransport(
    f.root,
    { url: 'https://fixture.invalid', projectId: f.s.projectId },
    f.exchange,
  );
  const reported = f.c.calls.length;
  await assert.rejects(agent.dispatch('status', {}), error => {
    assert.equal(error.code, 'SAVE_SETTLE_FAILED');
    assert.match(error.message, new RegExp(command.operationId));
    assert.match(error.message, /WORK_STALE/);
    assert.match(error.message, /edits are still in this checkout/);
    assert.equal(error.recovery.failedSave, command.operationId);
    return true;
  });
  // The capability call every command makes carried the outcome: no extra read for it.
  assert.deepEqual(f.c.calls.slice(reported), ['projectHostedAgent:capabilities']);
  assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head, 'the marker never moved');
  // Reported once: the agent's retry of its command goes on with no call for the failed save.
  const retry = f.c.calls.length;
  await settleBackgroundSave(f.root, f.exchange);
  assert.equal(f.c.calls.length, retry);
});

test('a save whose server outlives the request window waits on its original operation and applies the real receipt', async t => {
  const { ForgeError } = await import('../dist/errors.js');
  const f = await setup(t),
    command = { operationId: randomUUID(), message: 'reconcile original save' },
    action = f.exchange.client.action;
  let serverReply,
    submits = 0;
  f.exchange.client.action = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectSourceRun:submit') return action(ref, args);
    submits++;
    // Server work is durable, but has not run its source step at caller expiry.
    serverReply = JSON.parse(await action(ref, { ...args, settle: 'background' }));
    throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'ordinary request window ended');
  };
  const saved = await saveHostedLane(
    f.root,
    command,
    f.exchange,
    { ...contract, settleBackground: false },
    false,
    undefined,
    async operationId => {
      assert.equal(operationId, command.operationId);
      assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
      await f.settle(serverReply.jobId);
      const progress = JSON.parse(
        await f.exchange.client.query(makeFunctionReference('projectHostedSaves:progress'), {
          projectId: f.s.projectId,
          operationId,
        }),
      );
      return progress.terminal;
    },
  );
  assert.equal(saved.outcome.status, 'completed');
  assert.notEqual(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
  assert.equal(submits, 1, 'the retained source work is never submitted again');
});
