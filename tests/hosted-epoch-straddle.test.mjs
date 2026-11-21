// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { observeHostedRun } from '../dist/hosted-agent-observe.js';
import { landWaitContinuation } from '../dist/hosted-land-wait.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { resolutionFixture, nextEpoch, dropFirst } from './hosted-agent-resolution-fixture.mjs';

// Item 1d69905b, review f08934a5: every kept request replayed under the same operation id after a
// source cutover (an authority epoch change) was refused forever. The N3 rule: refused before it
// began = rebuild under the same id; began at the old epoch = one refusal naming the next command.
const operations = (s, name) => s.calls.filter(call => call.name === name);
const requests = (s, name) => operations(s, name).map(call => JSON.parse(call.args.request));
const outcome = response =>
  response.result.outcome?.status ?? response.result.terminal?.outcome?.status ?? response.result.status;
/** The refusal names one next command: the same action under a fresh operation id. */
function namesNext(refused, action, operationId) {
  assert.match(refused.code, /^SOURCE_AUTHORITY_/);
  const { action: named, ...parameters } = refused.recovery.next;
  assert.equal(named, action);
  assert.notEqual(parameters.operationId, operationId, 'a new operation, not a replay of this one');
  assert(refused.recovery.command.includes(parameters.operationId));
  return parameters;
}

test('a start that never began rebuilds at the new epoch under the same operation (1d69905b start)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedStart:start');
  // The model is declared so the start does not depend on the caller's agent environment.
  const command = {
    outcome: 'Epoch straddle start',
    model: 'model-test-1',
    operationId: randomUUID(),
    path: join(s.root, '..', 'started'),
  };
  await assert.rejects(s.transport().dispatch('start', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const started = await s.transport().dispatch('start', command);
  assert.equal(started.operationId, command.operationId);
  assert(started.result.lane.laneId);
  // The retained request is refused once at the old epoch (nothing began), then rebuilt at the new one.
  const sent = operations(s, 'projectHostedStart:start').map(call => call.args.authorityEpoch);
  assert.deepEqual(sent, [epoch - 1, epoch]);
});

test('a sync that never began rebuilds at the new epoch under the same operation (1d69905b plain sync)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  f.moveMain();
  dropFirst(s, 'projectHostedSync:prepare');
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('sync', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const synced = await s.transport().dispatch('sync', command);
  assert.equal(synced.operationId, command.operationId);
  assert.deepEqual(
    requests(s, 'projectHostedSync:prepare').map(request => request.authorityEpoch),
    [epoch - 1, epoch],
  );
});

test('a sync whose job was submitted at the old epoch ends at its replayed prepare with the next command: no upload, submit or wait (1d69905b sync began)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  f.moveMain();
  s.eagerSource(false);
  const controller = new AbortController();
  controller.abort();
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  const pending = await s.transport().dispatch('sync', command, controller.signal);
  assert.equal(pending.result.status, 'submitted', 'its job was submitted at the old epoch');
  nextEpoch(f);
  // Every write and callback of that job is refused now: a wait (a replay) ends with the refusal.
  const before = s.calls.length;
  const refused = await s
    .transport()
    .dispatch('sync', command, controller.signal)
    .catch(error => error);
  const parameters = namesNext(refused, 'sync', command.operationId);
  assert.deepEqual(
    s.calls
      .slice(before)
      .map(call => call.name)
      .filter(name => !/capabilities/.test(name)),
    ['projectHostedSync:prepare'],
    'no submit, upload or wait after the replayed prepare',
  );
  s.eagerSource(true);
  const next = await s.transport().dispatch('sync', parameters);
  assert.equal(next.operationId, parameters.operationId);
  assert.notEqual(outcome(next), 'submitted');
});

test('a resolution sync that never began rebuilds at the new epoch under the same operation (1d69905b resolution sync)', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const first = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
  const candidateId = first.result.candidateId;
  assert(candidateId, 'a conflicted Candidate');
  dropFirst(s, 'projectHostedSync:prepare');
  const command = { candidateId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('sync', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const synced = await s.transport().dispatch('sync', command);
  assert.equal(synced.operationId, command.operationId);
  assert(synced.result.conflict.root, 'the resolution Lane opened');
  const sent = requests(s, 'projectHostedSync:prepare').filter(r => r.operationId === command.operationId);
  assert.deepEqual(
    sent.map(r => r.authorityEpoch),
    [epoch - 1, epoch],
  );
});

test('a compose that never began rebuilds at the new epoch under the same operation (1d69905b compose)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedCompose:prepare');
  const command = { laneId: f.lane.laneId, message: 'Compose across a cutover', operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('compose', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const composed = await s.transport().dispatch('compose', command);
  assert.equal(composed.operationId, command.operationId);
  assert.equal(outcome(composed), 'completed');
  assert.deepEqual(
    requests(s, 'projectHostedCompose:prepare').map(request => request.authorityEpoch),
    [epoch - 1, epoch],
  );
});

test('a compose that began at the old epoch is refused with the next command, and that command composes (1d69905b compose began)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedComposeJobs:submit');
  const command = { laneId: f.lane.laneId, message: 'Compose across a cutover', operationId: randomUUID() },
    composes = f.tables.projectHostedComposes.size;
  await assert.rejects(s.transport().dispatch('compose', command));
  assert.equal(f.tables.projectHostedComposes.size, composes + 1, 'the compose began at the old epoch');
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('compose', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'compose', command.operationId);
  const composed = await s.transport().dispatch('compose', parameters);
  assert.equal(outcome(composed), 'completed');
});

test('a finish whose compose began at the old epoch composes again under the same finish operation (1d69905b finish compose)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedComposeJobs:submit');
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('finish', command));
  const epoch = nextEpoch(f);
  const landed = await s.transport().dispatch('finish', command);
  assert.equal(landed.operationId, command.operationId);
  assert(landed.result.submission, 'the landing was submitted');
  assert.equal(landed.result.submission.request.authorityEpoch, epoch);
  const composes = requests(s, 'projectHostedCompose:prepare');
  assert.equal(new Set(composes.map(request => request.operationId)).size, 2, 'a new compose operation');
  assert.equal(composes.at(-1).authorityEpoch, epoch);
});

test('a landing request that never began rebuilds at the new epoch under the same finish (1d69905b enqueue)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedLanding:enqueue');
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('finish', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const landed = await s.transport().dispatch('finish', command);
  assert.equal(landed.operationId, command.operationId);
  assert.equal(landed.result.submission.request.authorityEpoch, epoch);
  assert.deepEqual(
    requests(s, 'projectHostedLanding:enqueue').map(request => request.authorityEpoch),
    [epoch - 1, epoch],
  );
});

test('a desired landing that never began rebuilds at the new epoch under the same finish (1d69905b desired landing)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  s.eagerSource(false);
  dropFirst(s, 'projectHostedLandingDesired:submit');
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('finish', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const landed = await s.transport().dispatch('finish', command);
  assert.equal(landed.operationId, command.operationId);
  assert.equal(landed.result.submission.request.authorityEpoch, epoch);
  assert.deepEqual(
    requests(s, 'projectHostedLandingDesired:submit').map(request => request.authorityEpoch),
    [epoch - 1, epoch],
  );
});

test('a desired landing that began at the old epoch is refused with the next command, and that command lands (1d69905b desired began)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  s.eagerSource(false);
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.submission.phase, 'composing', 'began at the old epoch, still composing');
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('finish', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'finish', command.operationId);
  s.eagerSource(true);
  const landed = await s.transport().dispatch('finish', parameters);
  assert.equal(landed.operationId, parameters.operationId);
  assert.notEqual(landed.result.submission.phase, 'terminal-failed');
});

test('ad80e037: a capped landing retains maxChecks across an authority epoch change', async t => {
  const switchName = 'FORGE_QUEUE_LAND_WHEN_ROOM';
  const previous = process.env[switchName];
  process.env[switchName] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[switchName];
    else process.env[switchName] = previous;
  });
  const maxChecks = 5;
  for (const [route, eager] of [
    ['projectHostedLanding:enqueue', true],
    ['projectHostedLandingDesired:submit', false],
  ]) {
    await t.test(route, async t => {
      const s = await resolutionFixture(t);
      s.eagerSource(eager);
      dropFirst(s, route);
      const command = { laneId: s.f.lane.laneId, operationId: randomUUID(), maxChecks };
      await assert.rejects(s.transport().dispatch('finish', command), { code: 'HOSTED_ACTION_FAILED' });
      const epoch = nextEpoch(s.f);
      const reply = await s.transport().dispatch('finish', command);
      assert.equal(reply.operationId, command.operationId);
      assert.equal(reply.result.submission.request.authorityEpoch, epoch);
      assert.deepEqual(
        operations(s, route).map(call => call.args.maxChecks),
        [maxChecks, maxChecks],
      );
    });
  }

  await t.test('a named fresh finish', async t => {
    const s = await resolutionFixture(t);
    s.eagerSource(false);
    const command = { laneId: s.f.lane.laneId, operationId: randomUUID(), maxChecks };
    const first = await s.transport().dispatch('finish', command);
    assert.equal(first.result.submission.phase, 'composing');
    const epoch = nextEpoch(s.f);
    const refused = await s
      .transport()
      .dispatch('finish', command)
      .catch(error => error);
    const parameters = namesNext(refused, 'finish', command.operationId);
    assert.equal(parameters.maxChecks, maxChecks);
    s.eagerSource(true);
    const reply = await s.transport().dispatch('finish', parameters);
    assert.equal(reply.result.submission.request.authorityEpoch, epoch);
    assert.equal(operations(s, 'projectHostedLanding:enqueue').at(-1).args.maxChecks, maxChecks);
  });
});

test('a plain save that began at the old epoch is refused naming save, and that save completes (review f08934a5 low 3)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), 'saved across a cutover\n');
  dropFirst(s, 'projectHostedSaveJobs:submit');
  const command = { message: 'Save across a cutover', operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('save', command));
  assert.equal(f.tables.projectHostedSaves.size, 1, 'the save began at the old epoch');
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('save', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'save', command.operationId);
  const saved = await s.transport().dispatch('save', parameters);
  assert.equal(outcome(saved), 'completed');
});

test('a finish whose save began at the old epoch is refused naming finish, and that finish lands (review f08934a5 low 3)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), 'landed across a cutover\n');
  dropFirst(s, 'projectHostedSaveJobs:submit');
  const command = { laneId: f.lane.laneId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('finish', command));
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('finish', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'finish', command.operationId);
  const landed = await s.transport().dispatch('finish', parameters);
  assert(landed.result.submission, 'the new finish submitted its landing');
});

test('an abandon whose save-first began at the old epoch names abandon (review f08934a5 low 2)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), 'kept before abandon\n');
  dropFirst(s, 'projectHostedSaveJobs:submit');
  const command = { reason: 'Superseded', saveFirst: true, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('abandon', command));
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('abandon', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'abandon', command.operationId);
  assert.equal(parameters.reason, 'Superseded');
  assert.equal(parameters.saveFirst, true);
  const abandoned = await s.transport().dispatch('abandon', parameters);
  assert.equal(abandoned.operationId, parameters.operationId);
});

// Review 276b168f finding 1: a save left pending at the old epoch was resumed, without this
// command's epoch, by the next save, finish, sync or lifecycle command of the checkout, which then
// failed for good. That save can never finish: it is dropped, and the new capture keeps its edits.
async function pendingOldEpochSave(s) {
  const f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), 'left pending across a cutover\n');
  dropFirst(s, 'projectHostedSaveJobs:submit');
  await assert.rejects(
    s.transport().dispatch('save', { message: 'Pending save', operationId: randomUUID() }),
  );
  nextEpoch(f);
}

test('a new save after a save that began at the old epoch saves its edits (review 276b168f F1 settle)', async t => {
  const s = await resolutionFixture(t);
  await pendingOldEpochSave(s);
  writeFileSync(join(s.root, 'b.txt'), 'saved after the cutover\n');
  const saved = await s.transport().dispatch('save', { message: 'After cutover', operationId: randomUUID() });
  assert.equal(outcome(saved), 'completed');
  const lane = await s.f.readLane(s.f.lane.laneId);
  assert.notEqual(lane.head, s.f.lane.head, 'the Lane moved');
  // Review b5e08676 low 1: the dropped save's edit is captured by the new save, not lost.
  assert.equal(s.f.text(lane.head, 'a.txt'), 'left pending across a cutover\n');
  assert.equal(s.f.text(lane.head, 'b.txt'), 'saved after the cutover\n');
  const again = await s.transport().dispatch('save', { message: 'Nothing new', operationId: randomUUID() });
  assert.notEqual(again.result?.code, 'SOURCE_AUTHORITY_CHANGED', 'no later save replays the dropped one');
});

test('a new finish after a save that began at the old epoch lands (review 276b168f F1 reconcile)', async t => {
  const s = await resolutionFixture(t);
  await pendingOldEpochSave(s);
  const landed = await s
    .transport()
    .dispatch('finish', { laneId: s.f.lane.laneId, operationId: randomUUID() });
  assert(landed.result.submission, 'the landing was submitted');
  assert.notEqual(landed.result.submission.phase, 'terminal-failed');
});

test('a background save submitted at the old epoch does not block the next save (review 276b168f F1 background)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), 'submitted across a cutover\n');
  s.eagerSource(false);
  const controller = new AbortController();
  controller.abort();
  const pending = await s
    .transport()
    .dispatch('save', { message: 'Submitted save', operationId: randomUUID() }, controller.signal);
  assert(['submitted', 'settling'].includes(pending.result.status), `pending: ${pending.result.status}`);
  nextEpoch(f);
  s.eagerSource(true);
  const saved = await s.transport().dispatch('save', { message: 'After cutover', operationId: randomUUID() });
  assert.equal(outcome(saved), 'completed');
});

test('a finish with its own compose operation that began at the old epoch names a finish that composes again (review 276b168f F2)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedComposeJobs:submit');
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), composeOperationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('finish', command));
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('finish', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'finish', command.operationId);
  assert.equal(parameters.composeOperationId, undefined, 'the dead compose is not named again');
  const landed = await s.transport().dispatch('finish', parameters);
  assert(landed.result.submission, 'the named finish submitted its landing');
});

// Review b5e08676 low 2: a resolution sync (a Candidate's) whose job was submitted at the old epoch.
test('a resolution sync that began at the old epoch is refused naming sync, and that sync opens the resolution Lane (review b5e08676 low 2)', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const first = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
  const candidateId = first.result.candidateId;
  assert(candidateId, 'a conflicted Candidate');
  dropFirst(s, 'projectHostedSyncJobs:submit');
  const command = { candidateId, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('sync', command));
  nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('sync', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'sync', command.operationId);
  assert.equal(parameters.candidateId, candidateId, 'the named sync keeps its Candidate');
  const synced = await s.transport().dispatch('sync', parameters);
  assert.equal(synced.operationId, parameters.operationId);
  assert(synced.result.conflict.root, 'the resolution Lane opened');
});

// Review 85381d50 low 2: the resolve's own sync began at the old epoch.
test('a resolve whose sync began at the old epoch is refused naming resolve, and that resolve resolves (review 85381d50 low 2)', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport().dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  dropFirst(s, 'projectHostedSyncJobs:submit');
  const command = { laneId: conflict.laneId, operationId: randomUUID() };
  await assert.rejects(s.transport(conflict.root).dispatch('resolve', command));
  nextEpoch(f);
  const refused = await s
    .transport(conflict.root)
    .dispatch('resolve', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'resolve', command.operationId);
  const fixed = await s.transport(conflict.root).dispatch('resolve', parameters);
  assert.equal(fixed.result.source.outcome.result.status, 'resolved');
});

// Review b5e08676 low 3, decided: keep the rebuild. A save that never began (lost before the server
// ran its prepare), then a cutover. A next save's settle reads NOT_FOUND and drops it (its edits
// are in the checkout). A finish or preflight reconciles it instead: an unknown reply resumes the
// original operation, and at a newer epoch that is the N3 rule, rebuilt once under its id.
test('a finish after a save that never began before a cutover rebuilds that save at the new epoch under its id and lands both edits (review b5e08676 low 3)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), 'never began before a cutover\n');
  dropFirst(s, 'projectHostedSaves:prepare');
  const lost = { message: 'Never began', operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('save', lost), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  writeFileSync(join(s.root, 'b.txt'), 'edited after the cutover\n');
  const landed = await s.transport().dispatch('finish', { laneId: f.lane.laneId, operationId: randomUUID() });
  assert(landed.result.submission, 'the landing was submitted');
  assert.deepEqual(
    requests(s, 'projectHostedSaves:prepare')
      .filter(request => request.operationId === lost.operationId)
      .map(request => request.authorityEpoch),
    [epoch - 1, epoch],
    'refused once at its old epoch (nothing began), rebuilt once at the new one',
  );
  const lane = await f.readLane(f.lane.laneId);
  assert.equal(f.text(lane.head, 'a.txt'), 'never began before a cutover\n');
  assert.equal(f.text(lane.head, 'b.txt'), 'edited after the cutover\n');
});

// The check-only finish (land --save --check-only) retains its check request like a landing does.
test('a check-only finish whose check request never began rebuilds at the new epoch under the same finish (1d69905b check-only)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  dropFirst(s, 'projectHostedChecks:enqueue');
  const command = { laneId: f.lane.laneId, accept: false, operationId: randomUUID() };
  await assert.rejects(s.transport().dispatch('finish', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(f);
  const checked = await s.transport().dispatch('finish', command);
  assert.equal(checked.operationId, command.operationId);
  assert.equal(checked.result.phase, 'check');
  assert.equal(typeof checked.result.run.id, 'string');
  assert.deepEqual(
    requests(s, 'projectHostedChecks:enqueue').map(request => request.authorityEpoch),
    [epoch - 1, epoch],
  );
});

// Review a81344b8 finding 1: a check-only run enqueued at the old epoch is still running at the
// cutover. Every runner write to it is refused from then on, so it never ends: the replay names a
// new finish instead of waiting on it, and that finish checks at the new epoch.
test('a check-only finish whose check began at the old epoch is refused naming finish, and that finish checks again (review a81344b8 1)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  const command = { laneId: f.lane.laneId, accept: false, operationId: randomUUID() };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.phase, 'check');
  const epoch = nextEpoch(f);
  const refused = await s
    .transport()
    .dispatch('finish', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'finish', command.operationId);
  assert.equal(parameters.accept, false, 'the named finish is check-only too');
  const checked = await s.transport().dispatch('finish', parameters);
  assert.equal(checked.result.phase, 'check');
  assert.notEqual(checked.result.run.id, first.result.run.id, 'a new check run');
  assert.equal(requests(s, 'projectHostedChecks:enqueue').at(-1).authorityEpoch, epoch);
});

test('the check-only run wait ends across a cutover, both before and during the subscription (96c473d7)', async t => {
  const s = await resolutionFixture(t);
  const first = await s.transport().dispatch('finish', { laneId: s.f.lane.laneId, accept: false });
  const wait = landWaitContinuation(s.root, first).next;
  assert.equal(wait.runId, first.result.run.id);
  let unsubscribed = false,
    closed = false;
  const subscribed = await observeHostedRun(
    s.transport(),
    { runId: wait.runId },
    undefined,
    undefined,
    () => ({
      onUpdate(ref, args, update, error) {
        nextEpoch(s.f);
        void s.exchange.client.query(ref, args).then(value => {
          update(value);
          // A client missing the epoch check would continue to the next update and return a pass.
          update({ ...JSON.parse(value), status: 'passed' });
        }, error);
        return () => {
          unsubscribed = true;
        };
      },
      async close() {
        closed = true;
      },
    }),
  ).catch(error => error);
  assert(unsubscribed && closed, 'the cutover releases the running wait');
  const parameters = namesNext(subscribed, 'check', first.result.run.request.operationId);
  assert.equal(parameters.candidateId, first.result.run.request.candidateId);
  assert.equal(parameters.expectedHead, first.result.run.request.expectedHead);
  const before = s.calls.length;
  const read = await observeHostedRun(s.transport(), { runId: wait.runId, timeoutSeconds: 0 }).catch(
    error => error,
  );
  namesNext(read, 'check', first.result.run.request.operationId);
  assert.deepEqual(
    s.calls
      .slice(before)
      .map(call => call.name)
      .filter(name => !name.endsWith(':capabilities')),
    ['projectHostedCheckRead:status'],
  );
  const checked = await s.transport().dispatch('check', parameters);
  assert.notEqual(checked.result.id, wait.runId, 'the named check reserves a new run on those same pins');
  assert.equal(checked.result.request.expectedHead, parameters.expectedHead);
  assert.equal(checked.result.request.authorityEpoch, first.result.run.request.authorityEpoch + 1);
});

for (const cutover of [false, true])
  test(`abandon resumes between the child save and parent request${cutover ? ' across a cutover' : ''}`, async t => {
    const s = await resolutionFixture(t);
    await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
    writeFileSync(join(s.root, 'a.txt'), 'saved before the interruption\n');
    // Fail the first parent send, then restore the journal as left before the parent was retained.
    dropFirst(s, 'projectHostedLifecycle:transition');
    const command = { operationId: randomUUID(), reason: 'Crash after the child completed', saveFirst: true };
    await assert.rejects(s.transport().dispatch('abandon', command), { code: 'HOSTED_ACTION_FAILED' });
    const journal = join(`${s.root}.forge-client`, 'lifecycle', `${command.operationId}.json`);
    const original = JSON.parse(readFileSync(journal, 'utf8'));
    writeFileSync(journal, JSON.stringify({ ...original, request: null }));
    const savedHead = readHostedLaneCheckout(s.root).selection.head;
    if (cutover) nextEpoch(s.f);
    writeFileSync(join(s.root, 'a.txt'), 'local edit after the save\n');
    const reply = await s.transport().dispatch('abandon', command);
    assert.equal(reply.result.result.status, 'applied');
    assert.equal(reply.result.result.saveOperationId, original.saveOperationId);
    assert.equal(reply.result.result.lane.head, savedHead);
    assert.equal(s.f.text(savedHead, 'a.txt'), 'saved before the interruption\n');
    assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'local edit after the save\n');
    assert.equal(s.f.tables.projectHostedSaves.size, 1, 'the exact child was reused');
  });

test('a retained lifecycle request refreshes its epoch and preserves explicit Intent pins (2d71df3d)', async t => {
  const s = await resolutionFixture(t);
  const command = {
    reason: 'Superseded',
    operationId: randomUUID(),
    target: { kind: 'intent', intentId: s.f.c.intentId, version: 0 },
  };
  dropFirst(s, 'projectHostedLifecycle:transition');
  await assert.rejects(s.transport().dispatch('abandon', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(s.f);
  const result = await s.transport().dispatch('abandon', command);
  assert.equal(result.result.status, 'applied');
  const sent = requests(s, 'projectHostedLifecycle:transition');
  assert.deepEqual(
    sent.map(r => r.authorityEpoch),
    [epoch - 1, epoch],
  );
  assert.deepEqual(sent[0].target, sent[1].target);
  assert.equal(sent[1].operationId, command.operationId);
});

test('a lifecycle plan begun before a cutover names a fresh abandon, preserving its target (2d71df3d)', async t => {
  const s = await resolutionFixture(t);
  const command = {
    reason: 'Superseded cascade',
    operationId: randomUUID(),
    target: { kind: 'intent', intentId: s.f.c.intentId, version: 0, cascade: true },
  };
  const result = await s.transport().dispatch('abandon', command);
  assert.equal(result.result.status, 'pending');
  const epoch = nextEpoch(s.f);
  const refused = await s
    .transport()
    .dispatch('abandon', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'abandon', command.operationId);
  assert.deepEqual(parameters.target, command.target);
  assert.deepEqual(
    requests(s, 'projectHostedLifecycle:transition').map(r => r.authorityEpoch),
    [epoch - 1, epoch - 1],
  );
  const next = await s.transport().dispatch('abandon', parameters);
  assert.notEqual(next.result.receiptId, result.result.receiptId);
});

test('a pending lifecycle replay on an older server keeps the original request for an upgraded server', async t => {
  const s = await resolutionFixture(t);
  const command = {
    reason: 'Superseded cascade',
    operationId: randomUUID(),
    target: { kind: 'intent', intentId: s.f.c.intentId, version: 0, cascade: true },
  };
  const result = await s.transport().dispatch('abandon', command);
  assert.equal(result.result.status, 'pending');
  const epoch = nextEpoch(s.f);
  const query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const value = await query(ref, args);
    if (getFunctionName(ref) !== 'projectHostedAgent:capabilities') return value;
    const reply = JSON.parse(value);
    return JSON.stringify({
      ...reply,
      features: reply.features.filter(feature => feature !== 'source-epoch-recovery'),
    });
  };
  await assert.rejects(s.transport().dispatch('abandon', command), { code: 'SOURCE_AUTHORITY_CHANGED' });
  assert.equal(operations(s, 'projectHostedLifecycle:transition').at(-1).args.replayEpoch, undefined);
  s.exchange.client.query = query;
  const refused = await s
    .transport()
    .dispatch('abandon', command)
    .catch(error => error);
  namesNext(refused, 'abandon', command.operationId);
  const sent = requests(s, 'projectHostedLifecycle:transition');
  assert.deepEqual(
    sent.map(r => r.authorityEpoch),
    [epoch - 1, epoch - 1, epoch - 1],
  );
});

test('standalone check refreshes a refused request and ends the replay of a stranded run', async t => {
  const s = await resolutionFixture(t);
  const command = {
    operationId: randomUUID(),
    candidateId: s.f.candidate.id,
    checkId: s.f.rawChecks.checkId,
  };
  dropFirst(s, 'projectHostedChecks:enqueue');
  await assert.rejects(s.transport().dispatch('check', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(s.f);
  const checked = await s.transport().dispatch('check', command);
  assert.equal(checked.operationId, command.operationId);
  assert.equal(checked.result.request.authorityEpoch, epoch);
  nextEpoch(s.f);
  const refused = await s
    .transport()
    .dispatch('check', command)
    .catch(error => error);
  const parameters = namesNext(refused, 'check', command.operationId);
  assert.equal(parameters.expectedHead, checked.result.request.expectedHead);
  assert.equal(parameters.expectedDefinition, checked.result.request.expectedDefinition);
  assert.deepEqual(
    requests(s, 'projectHostedChecks:enqueue').map(r => r.authorityEpoch),
    [epoch - 1, epoch, epoch],
  );
});

test('a retained revert refreshes its epoch before begin and gives a fresh revert after begin (2d71df3d)', async t => {
  const s = await resolutionFixture(t);
  const receipt = await s.f.landOriginal();
  s.eagerSource(false);
  const command = {
    target: { kind: 'receipt', receiptId: receipt.id },
    message: 'Reverse the recorded landing',
    operationId: randomUUID(),
  };
  dropFirst(s, 'projectHostedSync:prepare');
  await assert.rejects(s.transport().dispatch('revert', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(s.f);
  assert.equal((await s.transport().dispatch('revert', command)).result.status, 'submitted');
  const sent = requests(s, 'projectHostedSync:prepare');
  assert.deepEqual(
    sent.map(r => r.authorityEpoch),
    [epoch - 1, epoch],
  );
  assert.deepEqual(sent[0].target, sent[1].target);
  nextEpoch(s.f);
  const before = s.calls.length;
  const refused = await s
    .transport()
    .dispatch('revert', command)
    .catch(error => error);
  const next = namesNext(refused, 'revert', command.operationId);
  assert.deepEqual(next.target, command.target);
  assert.deepEqual(
    s.calls
      .slice(before)
      .map(call => call.name)
      .filter(name => !name.endsWith(':capabilities')),
    ['projectHostedSync:prepare'],
  );
});

for (const action of ['cancel', 'withdraw'])
  test(`a retained ${action} by submission refreshes its epoch without changing the target (2d71df3d)`, async t => {
    const s = await resolutionFixture(t);
    const first = await s.f.enqueue(s.f.request());
    const command = { submissionId: first.id, operationId: randomUUID() };
    dropFirst(s, 'projectHostedLanding:cancel');
    await assert.rejects(s.transport().dispatch(action, command), { code: 'HOSTED_ACTION_FAILED' });
    // Real cutovers drain live landings. Keep its terminal record available for the replay.
    await s.transport().dispatch('cancel', { ...command, operationId: randomUUID() });
    const epoch = nextEpoch(s.f);
    const reply = await s.transport().dispatch(action, command);
    assert.equal(reply.operationId, command.operationId);
    assert.equal((reply.result.landing ?? reply.result).id, first.id);
    const sent = requests(s, 'projectHostedLanding:cancel').filter(
      r => r.operationId === command.operationId,
    );
    assert.deepEqual(
      sent.map(r => r.authorityEpoch),
      [epoch - 1, epoch],
    );
    assert(sent.every(r => r.submissionId === first.id));
  });

test('pin already reads the current epoch on replay after a cutover (2d71df3d)', async t => {
  const s = await resolutionFixture(t);
  const command = { laneId: s.f.lane.laneId, pinned: true, operationId: randomUUID() };
  dropFirst(s, 'projectHostedLanePin:setPin');
  await assert.rejects(s.transport().dispatch('pin', command), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(s.f);
  const reply = await s.transport().dispatch('pin', command);
  assert.equal(reply.result.pinned, true);
  assert.equal(operations(s, 'projectHostedLanePin:setPin').at(-1).args.authorityEpoch, epoch);
});

test('a refused withdraw by Lane uses the current epoch and a completed withdraw keeps its original submission (2d71df3d)', async t => {
  const s = await resolutionFixture(t);
  const first = await s.f.enqueue(s.f.request());
  const command = { laneId: s.f.lane.laneId, operationId: randomUUID() };
  dropFirst(s, 'projectHostedLandingWithdraw:withdraw');
  await assert.rejects(s.transport().dispatch('withdraw', command), { code: 'HOSTED_ACTION_FAILED' });
  await s.transport().dispatch('cancel', { submissionId: first.id });
  const epoch = nextEpoch(s.f);
  const second = (await s.transport().dispatch('finish', { laneId: s.f.lane.laneId })).result.submission;
  assert(second?.id, 'a new live landing at the current epoch');
  const reply = await s.transport().dispatch('withdraw', command);
  assert.equal(reply.operationId, command.operationId);
  assert.equal(reply.result.submissionId, second.id);
  assert.deepEqual(
    requests(s, 'projectHostedLandingWithdraw:withdraw').map(r => r.authorityEpoch),
    [epoch - 1, epoch],
  );
  nextEpoch(s.f);
  const replay = await s.transport().dispatch('withdraw', command);
  assert.equal(replay.result.submissionId, second.id);
  assert.equal(requests(s, 'projectHostedLandingWithdraw:withdraw').at(-1).authorityEpoch, epoch);
});

test('resolve preserves its original inputs and replaces a stranded prefix compose after cutover (2d71df3d)', async t => {
  const s = await resolutionFixture(t, { overlap: true });
  const f = s.f;
  f.moveMain({ overlap: true });
  const dependency = { candidateId: f.candidate.id, head: f.candidate.result.head };
  const composition = await s.transport().dispatch('compose', {
    laneId: f.lane.laneId,
    dependencies: [dependency],
    message: 'Compose with dependency',
  });
  const candidate = composition.result.outcome.result;
  assert.equal(candidate.result.status, 'conflict');
  const draft = await s.transport().dispatch('sync', { candidateId: candidate.id });
  const { root, laneId } = draft.result.conflict;
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  const controller = new AbortController();
  s.eagerSource(name => {
    if (name !== 'projectHostedComposeJobs:submit') return true;
    controller.abort();
    return false;
  });
  const command = { laneId, operationId: randomUUID() };
  const pending = await s.transport(root).dispatch('resolve', command, controller.signal);
  assert.equal(pending.result.phase, 'compose');
  const oldPrefix = pending.result.composeOperationId;
  const epoch = nextEpoch(f);
  s.eagerSource(true);
  const done = await s.transport(root).dispatch('resolve', command);
  assert.equal(done.operationId, command.operationId);
  assert.equal(done.result.next.action, 'finish');
  assert.deepEqual(done.result.next.dependencies.slice(1), [dependency]);
  assert.equal(done.result.next.inputs[0].laneId, f.lane.laneId);
  const prepares = requests(s, 'projectHostedCompose:prepare').slice(-2);
  assert.equal(prepares[0].operationId, oldPrefix, 'read the original prefix prepare');
  assert.notEqual(prepares[1].operationId, oldPrefix, 'replace only the stranded compose operation');
  assert.equal(prepares[1].authorityEpoch, epoch);
});
