// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
