// SPDX-License-Identifier: Apache-2.0
// Per-member authority (Issue 8809fba5, GitHub norm): a contributor changes only their own Lanes,
// landings and overlap answers; the project owner may act on anyone's. Readers change nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { lifecycleFixture } from './hosted-lane-lifecycle-fixture.mjs';
import { api as saveApi } from './hosted-saves-fixture.mjs';
import { landingFixture, api as landingApi } from './hosted-landing-fixture.mjs';
import { composeFixture, api as composeApi } from './hosted-compose-fixture.mjs';
import { syncFixture, api as syncApi } from './hosted-sync-fixture.mjs';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

const denied = error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE';
const contributor = (f, name = 'writer') =>
  f.insert('projectContributors', { projectId: f.projectId, contributor: name });

test('class guard: public mutations that select a client-named Lane or landing check member authority', () => {
  const dir = new URL('../convex/', import.meta.url);
  const selects = /\b(?:saveLaneRecord|saveLane|lifecycleTarget)\(/;
  const publicMutation = /=\s*(?:mutation|receiptMutation)\(/;
  const unguarded = readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .filter(name => {
      const source = readFileSync(new URL(name, dir), 'utf8');
      return (
        publicMutation.test(source) && selects.test(source) && !source.includes("'./projectLaneAuthority'")
      );
    });
  assert.deepEqual(unguarded, [], 'call requireMemberAuthority before changing a selected Lane');
  // Landing entry points select by submission or Candidate id, not by Lane.
  for (const name of [
    'projectHostedLandingCancel.ts',
    'projectHostedLandingPins.ts',
    'projectHostedOverlaps.ts',
  ])
    assert.match(readFileSync(new URL(name, dir), 'utf8'), /from '\.\/projectLaneAuthority'/, name);
});

async function saveRequest(f, laneId) {
  const built = buildSavePages([f.change()]);
  return {
    operationId: randomUUID(),
    laneId,
    authorityEpoch: 1,
    expected: f.expected,
    message: 'synthetic save',
    pages: built.root,
    pageCount: built.pages.length,
    changeCount: 1,
  };
}
const prepareSave = async (f, laneId, actor) =>
  JSON.parse(
    await f.call(
      'prepare',
      saveApi.prepare,
      { projectId: f.projectId, request: JSON.stringify(await saveRequest(f, laneId)) },
      actor,
    ),
  );

test('save: a contributor cannot save over another member Lane; author and owner can', async () => {
  const f = await lifecycleFixture();
  contributor(f);
  const own = await f.addLane({ actor: 'writer' });
  await assert.rejects(prepareSave(f, f.laneId, 'writer'), denied);
  assert.equal(f.tables.projectHostedSaves.size, 0, 'a refused save leaves no preparation');
  assert.equal((await prepareSave(f, own.id, 'writer')).state.status, 'staging');
  assert.equal((await prepareSave(f, own.id, 'owner')).state.status, 'staging', 'owner acts on anyone');
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  await assert.rejects(prepareSave(f, own.id, 'reader'), denied);
});

test('lifecycle: abandon and complete need the Lane author or the owner; owner override is recorded', async () => {
  const f = await lifecycleFixture();
  contributor(f);
  const lane = laneId => ({ kind: 'lane', laneId, expected: f.expected });
  for (const action of ['abandon', 'complete'])
    await assert.rejects(f.begin(f.request(lane(f.laneId), { action }), 'writer'), denied);
  assert.equal((await f.read(f.laneId)).state, 'active');
  const mine = await f.addLane({ actor: 'writer' }),
    theirs = await f.addLane({ actor: 'writer' });
  assert.equal((await f.begin(f.request(lane(mine.id)), 'writer')).status, 'applied');
  assert.equal((await f.read(mine.id)).state, 'abandoned');
  const override = f.request(lane(theirs.id), { action: 'complete' });
  assert.equal((await f.begin(override, 'owner')).status, 'applied');
  assert.equal((await f.read(theirs.id)).state, 'completed');
  const event = [...f.tables.projectHostedLifecycleEvents.values()]
    .map(row => JSON.parse(row.value))
    .find(e => e.operationId === override.operationId);
  assert.equal(event.actor, 'owner', 'the owner acting on a member Lane is recorded as the owner');
});

test('lifecycle: a contributor Intent cascade closes only their own Lanes', async () => {
  const f = await lifecycleFixture();
  contributor(f);
  const mine = await f.addLane({ actor: 'writer' });
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r, 'writer');
  await f.drain();
  assert.equal(f.plan(r).status, 'applied');
  assert.equal((await f.read(mine.id)).state, 'abandoned');
  assert.equal((await f.read(f.laneId)).state, 'active', 'the owner Lane stays open');
});

test('landing: only the submitter or the owner cancels; only the Candidate author or owner submits it', async () => {
  const f = await landingFixture();
  contributor(f);
  const owners = await f.enqueue();
  const cancel = (submissionId, actor) =>
    f
      .call(
        'landingCancel',
        landingApi.cancel,
        {
          projectId: f.projectId,
          request: JSON.stringify({ submissionId, operationId: randomUUID(), authorityEpoch: 1 }),
        },
        actor,
      )
      .then(JSON.parse);
  await assert.rejects(cancel(owners.id, 'writer'), denied);
  assert.equal((await f.status(owners.id)).request.phase === 'terminal-failed', false);
  await assert.rejects(f.enqueue(f.request(), 'writer'), denied, "another member's Candidate");
  const candidate = { ...f.rawChecks.candidate, id: randomUUID() };
  await f.call(
    'seedWriterCandidate',
    { _handler: (ctx, input) => records.writeHostedRecord(ctx, input) },
    { projectId: f.projectId, actor: 'writer', authorityEpoch: 1, expectedVersion: null, record: candidate },
    'writer',
  );
  const writers = await f.enqueue(f.request({ candidateId: candidate.id }), 'writer');
  assert.equal(writers.actor, 'writer');
  assert.equal((await cancel(writers.id, 'owner')).error.code, 'LANDING_CANCELLED', 'owner cancels anyone');
  const again = await f.enqueue(f.request({ candidateId: candidate.id }), 'writer');
  assert.equal((await cancel(again.id, 'writer')).error.code, 'LANDING_CANCELLED', 'submitter cancels');
});

test('compose and sync: a contributor cannot land or rewrite another member Lane', async () => {
  const s = await composeFixture();
  contributor(s);
  const pin = s.state([s.baseFile, s.hidden, s.file('b.txt', 'owner change')], [s.baseline.sha256]);
  const owners = await s.lane(pin),
    writers = await s.lane(pin, { actor: 'writer' });
  const compose = async (entry, actor) => {
    const x = s.selection([entry]);
    await s.call(
      'composePrepare',
      composeApi.prepare,
      { projectId: s.projectId, request: JSON.stringify(x.request) },
      actor,
    );
    for (const [index, page] of x.pages.inputs.entries()) {
      s.put(saveBytes(page.value));
      await s.call(
        'composeStage',
        composeApi.stage,
        {
          projectId: s.projectId,
          operationId: x.request.operationId,
          kind: 'inputs',
          index,
          page: JSON.stringify(page.value),
        },
        actor,
      );
    }
  };
  await assert.rejects(compose(owners, 'writer'), denied);
  await compose(writers, 'writer');
  await compose(writers, 'owner');

  const y = await syncFixture();
  contributor(y);
  const target = { kind: 'main', head: y.main.head, receiptId: y.main.receipt.id };
  const lanePin = y.state([y.baseFile, y.hidden, y.file('lane', 'local')], [y.baseline.sha256]);
  const ownerLane = await y.lane(lanePin),
    writerLane = await y.lane(lanePin, { actor: 'writer' });
  const sync = (lane, actor) =>
    y
      .call(
        'syncPrepare',
        syncApi.prepare,
        {
          projectId: y.projectId,
          request: JSON.stringify(y.request('sync', { laneId: lane.laneId, expected: y.pins(lane), target })),
        },
        actor,
      )
      .then(JSON.parse);
  await assert.rejects(sync(ownerLane, 'writer'), denied);
  assert.equal((await sync(writerLane, 'writer')).state.status, 'ready');
  assert.equal((await sync(writerLane, 'owner')).state.status, 'ready');
});

test('decision records name the server identity, never a client-chosen actor', async () => {
  const s = recordsFixture();
  const decide = actor =>
    s.request('projectHostedDecisions:decide', {
      operationId: randomUUID(),
      target: { kind: 'project' },
      decidedBy: 'Synthetic owner',
      what: 'Keep exact records',
      why: 'Retain context',
      ...(actor === undefined ? {} : { actor }),
    });
  assert.equal((await decide('someone-else-entirely')).actor.name, 'owner');
  assert.equal((await decide('other-account/ashen-firefly')).actor.name, 'owner');
  assert.equal((await decide('ashen-firefly')).actor.name, 'owner/ashen-firefly', 'own agent session slug');
  assert.equal((await decide(undefined)).actor.name, 'owner');
});
