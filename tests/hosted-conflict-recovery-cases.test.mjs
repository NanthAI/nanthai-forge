// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Incident replays for the 2026-11-05 conflict-recovery cases (Issue 36a087ea, lead comment):
// four builders needed manual steps after a composition conflict. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { landSummary } from '../dist/hosted-land-summary.js';
import { resolutionContinuation } from '../dist/hosted-conflict-precheck.js';
import { landWaitContinuation } from '../dist/hosted-land-wait.js';
import { followLocalOperation, localOperation } from '../dist/hosted-agent-wait-local.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { ForgeError } from '../dist/errors.js';
import { canonicalRoot } from '../dist/root-paths.js';
import { moduleUrl } from './convex-module.mjs';

const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

const strip = ({ action, ...parameters }) => [action, parameters];

/** Conflict on finish from the original Lane's own checkout, then follow the returned steps. */
async function conflicted(t, laneRoot, unchecked = false) {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  if (unchecked) {
    f.tables.projectHostedCheckSettings.clear();
    f.patch('hostedProjects', f.projectId, {
      checklessDefault: true,
      landingCheckId: null,
      hasCheckDefinitions: false,
      checkEntries: [],
    });
  }
  f.moveMain({ overlap: true });
  const root = laneRoot?.(s) ?? s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const command = { laneId: f.lane.laneId };
  const first = await s.transport(root).dispatch('finish', command);
  assert(first.result.recovery.conflict, 'the conflict returns its recovery');
  return { s, f, root, command, conflict: first.result.recovery.conflict };
}
async function resolveAndLand({ s, f, conflict }, extra = {}) {
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  const [resolve, parameters] = strip(conflict.next);
  const fixed = await s.transport(conflict.root).dispatch(resolve, parameters);
  const [finish, selection] = strip(fixed.result.next);
  const submitted = await s.transport(conflict.root).dispatch(finish, { ...selection, ...extra });
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  return { fixed, submitted };
}

test('case 1 (bd201506, 015bfc34, 2e264cd6): landing the resolution Lane completes the original Lane', async t => {
  const run = await conflicted(t);
  const { s, f, conflict } = run;
  // The Issue's Intent: its completion is what the next planning read reconciles (closes) the Issue on.
  const { intentId } = await f.readLane(f.lane.laneId);
  const draft = await f.readLane(conflict.laneId);
  assert.equal(draft.resolution.origin.laneId, f.lane.laneId, 'the resolution record names its original');
  assert.equal(draft.resolution.origin.head, f.lane.head);
  assert.match(conflict.automatic.undo, new RegExp(`completes the original Lane ${f.lane.laneId}`));
  await resolveAndLand(run);
  assert.equal((await f.readLane(conflict.laneId)).state, 'completed');
  const original = await f.readLane(f.lane.laneId);
  assert.equal(original.state, 'completed', 'no manual complete of the original Lane');
  assert.equal(original.head, f.lane.head, 'the original source is preserved');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
  const heads = [...f.tables.projectHostedRecordHeads.values()].filter(
    row => row.kind === 'lane' && row.parent === intentId,
  );
  assert(
    heads.every(row => row.status !== 'active'),
    'no open Lane left on the Intent',
  );
  const intent = await f.runAcceptance('intentRead', records.readHostedRecord, {
    ...f.auth,
    kind: 'intent',
    key: intentId,
  });
  // A completed Intent is what lets the next planning read close (reconcile) its Issue.
  assert.equal(JSON.parse(intent.value).status, 'completed');
  const prepares = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => JSON.parse(call.args.request));
  assert.deepEqual(
    prepares.filter(request => request.kind === 'resolution').map(request => request.originLaneId),
    [f.lane.laneId],
  );
});

// Item 3f70760d (frictions f1a09ee2, 5c2b5e1b; regression of 55024d40): a resolution Lane landed with
// keepOpen stayed open by request, and so did its conflicted original, for hours, raising blocking
// overlaps and conflicts on other builders' saves. Only the resolution Lane carries on.
test('incident replay 5c2b5e1b: a resolution Lane landed with keepOpen completes its original; the resolution stays open', async t => {
  const run = await conflicted(t);
  const { f, conflict } = run;
  await resolveAndLand(run, { keepOpen: true });
  assert.equal((await f.readLane(conflict.laneId)).state, 'active', 'keepOpen keeps the resolution Lane');
  const original = await f.readLane(f.lane.laneId);
  assert.equal(original.state, 'completed', 'its conflicted original completes');
  assert.equal(original.head, f.lane.head, 'the original source is preserved');
  const overlap = [...f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === f.lane.laneId);
  assert.equal(overlap?.open ?? false, false, 'the original leaves the open overlap index');
});

for (const [mode, options] of [
  ['default', {}],
  ['keepOpen', { keepOpen: true }],
  ['closes:false', { closes: false }],
])
  test(`unchecked resolution stamps its origin with the same receipt (${mode})`, async t => {
    const run = await conflicted(t, undefined, true);
    const { f, conflict } = run;
    const { submitted } = await resolveAndLand(run, options);
    const landed = (await f.current(submitted.result.submission.id)).submission;
    assert.equal(landed.request.check, null);
    assert.equal(landed.acceptance.checked, false);
    const stamp = id =>
      [...f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === id)?.landed;
    assert.equal(stamp(conflict.laneId).unchecked, true);
    assert.equal(stamp(f.lane.laneId).receiptId, landed.acceptance.receiptId);
    assert.equal(stamp(f.lane.laneId).unchecked, true);
    assert.equal((await f.readLane(f.lane.laneId)).state, options.closes === false ? 'active' : 'completed');
  });

// Item 593fc2d7 (Lane 0200969a, receipt 93b3b701): the original was saved again with the same bytes
// ("save to refresh binding"), so only its sourceVersion moved; it stayed open and was abandoned by
// hand. An original Lane completes by head: only a changed head holds new work (case 1).
for (const [name, change, expected, intentStatus] of [
  [
    'a same-bytes re-save (sourceVersion only) completes',
    lane => ({ sourceVersion: lane.sourceVersion + 1 }),
    'completed',
    'completed',
  ],
  [
    'a changed head still holds new work and stays open',
    lane => ({ head: 'f'.repeat(64), sourceVersion: lane.sourceVersion + 1 }),
    'active',
    'active',
  ],
])
  test(`593fc2d7 case 1: ${name}`, async t => {
    const run = await conflicted(t);
    const { f } = run;
    const { intentId } = await f.readLane(f.lane.laneId);
    await f.changeLane(f.lane.laneId, change(f.lane));
    await resolveAndLand(run);
    assert.equal((await f.readLane(f.lane.laneId)).state, expected);
    const intent = await f.runAcceptance('intentRead', records.readHostedRecord, {
      ...f.auth,
      kind: 'intent',
      key: intentId,
    });
    assert.equal(JSON.parse(intent.value).status, intentStatus, 'its Intent settles with it');
  });

test('case 2 (55d39f4e): land from the original Lane after resolution points at the resolution, never resolve again', async t => {
  const run = await conflicted(t);
  const { s, f, root, command, conflict } = run;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  const [resolve, parameters] = strip(conflict.next);
  const fixed = await s.transport(conflict.root).dispatch(resolve, parameters);
  // Resolved but not landed: the replay names the exact landing step of the resolution Lane.
  const pending = await s.transport(root).dispatch('finish', command);
  const step = pending.result.recovery.conflict;
  assert.equal(step.root, conflict.root);
  assert.equal(step.resolved, true);
  assert.deepEqual(step.next, fixed.result.next, 'the same finish operation, never a new landing');
  assert.match(landSummary(pending).join('\n'), /resolved and saved/);
  const [finish, selection] = strip(step.next);
  const submitted = await s.transport(step.root).dispatch(finish, selection);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  // Landed: the replay says so and hands out no step at all.
  const settled = await s.transport(root).dispatch('finish', command);
  const done = settled.result.recovery.conflict;
  assert.equal(done.state, 'completed');
  assert.equal(done.next, undefined);
  assert.equal(done.command, undefined);
  assert.match(landSummary(settled)[0], /^RESOLVED in Lane /);
  const resolutions = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => JSON.parse(call.args.request))
    .filter(request => request.kind === 'resolve');
  assert.equal(new Set(resolutions.map(request => request.operationId)).size, 1, 'one resolve operation');
});

test('case 2: an abandoned resolution Lane yields one fresh resolution command', async t => {
  const { s, f, root, command, conflict } = await conflicted(t);
  await f.changeLane(conflict.laneId, { state: 'abandoned' });
  const replay = await s.transport(root).dispatch('finish', command);
  const step = replay.result.recovery.conflict;
  assert.equal(step.state, 'abandoned');
  assert.equal(step.next.action, 'sync');
  assert(step.next.candidateId);
  assert.notEqual(step.next.operationId, undefined, 'a new operation, never the dropped draft');
  assert.match(step.command, / save --sync /);
});

test('case 4 (2e264cd6, 5b1c7e0e): the resolution happens in the original Lane folder, with the whole tree', async t => {
  const run = await conflicted(t, s => join(dirname(s.root), 'clone.forge-client', 'lanes', s.f.lane.laneId));
  const { root, conflict } = run;
  assert.equal(conflict.root, canonicalRoot(root), 'the same folder, never a sibling or nested copy');
  assert.match(conflict.workIn, /^WORK IN .* \(same folder\): it is now resolution Lane /);
  assert(!existsSync(join(dirname(canonicalRoot(root)), conflict.laneId)), 'no second folder');
  // Non-conflicting files are present, so helpers a hunk uses are readable in place.
  const files = run.f.files(run.f.currentMain().head).map(file => file.path);
  assert(files.length > 1);
  for (const path of files)
    assert(existsSync(join(conflict.root, path)), `${path} is in the resolution checkout`);
  await resolveAndLand(run);
});

test('syntax conflicts: recovery advice names the reason and asks for a parseable merge', () => {
  const advice = resolutionContinuation('/fixture/lane', randomUUID(), ['src/a.ts'], randomUUID(), [
    { path: 'src/a.ts', reason: 'merged result does not parse' },
  ]);
  assert.match(advice.instruction, /src\/a\.ts \(merged result does not parse\)/);
  assert.match(advice.instruction, /parses/);
  assert.equal(advice.next.action, 'resolve');
});

test('case 5 (2e264cd6): unfinished source preparation continues with wait, the same step as every landing', async t => {
  const root = '/fixture/lane';
  const preparing = {
    operationId: randomUUID(),
    result: { phase: 'compose', status: 'submitted', next: { action: 'finish' }, command: 'finish replay' },
  };
  const wait = landWaitContinuation(root, preparing);
  assert.equal(wait.next.action, 'wait');
  assert.deepEqual(wait.next.operationIds, [preparing.operationId]);
  // A retryable or failed source keeps its own recovery, never a wait.
  assert.equal(
    landWaitContinuation(root, { ...preparing, result: { ...preparing.result, status: 'retryable' } }),
    undefined,
  );

  // wait on that id: the server has no landing yet, so wait replays the retained finish by id.
  const s = await resolutionFixture(t);
  const address = s.address,
    command = { laneId: s.f.lane.laneId, message: 'Land it' };
  const journal = new HostedAgentJournal(s.root, address, 'owner', 'finish', command);
  await journal.id('finish-step');
  const operationId = journal.operationId;
  assert.deepEqual(localOperation(s.root, operationId), { kind: 'finish', command });
  const notFound = new ForgeError('NOT_FOUND', 'No landing for this operation yet.');
  const replays = [];
  const transport = (result, phase = 'compose') => ({
    address,
    root: s.root,
    waitUntil: undefined,
    dispatch: async (action, input) => {
      replays.push({ action, input });
      return { result: { phase, ...result } };
    },
  });
  const still = await followLocalOperation(
    transport({ status: 'submitted' }),
    s.root,
    { operationIds: [operationId], timeoutSeconds: 1 },
    notFound,
  );
  assert.equal(still.result.status, 'timeout', 'still preparing: the same wait resumes it');
  assert.deepEqual(replays.at(-1), { action: 'finish', input: { ...command, operationId } });
  const conflict = await followLocalOperation(
    transport({ recovery: { conflict: { next: { action: 'resolve' } } } }, 'conflict'),
    s.root,
    { operationIds: [operationId], timeoutSeconds: 1 },
    notFound,
  );
  assert.equal(conflict.result.status, 'terminal');
  assert.equal(conflict.result.recovery.conflict.next.action, 'resolve');
});
