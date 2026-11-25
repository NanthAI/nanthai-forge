// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { landingBodyCounts } from './observer-projection-budget.mjs';
import { compactDiscardedChecks, seedTicket, stampExecution } from './landing-ticket-fixture.mjs';
import { landingCosts } from '../dist/hosted-landings-view.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { batchEligible } from '../dist/hosted-landing-batch.js';
import { landingApi, compose, driver, isFinishWake } from './hosted-finish-fixture.mjs';
import { assertForkRacesNamed } from './fork-race-names.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('incident replay: four finishes in one minute share one full check and one atomic main publication', async t => {
  const spendLines = [];
  t.mock.method(console, 'log', (...args) => {
    if (String(args[0]).startsWith('FORGE_ACCEPTED_LANDINGS')) spendLines.push(args);
  });
  const f = await batchesFixture(t);
  const arrivals = states(f).map(s => Date.parse(s.at));
  assert(Math.max(...arrivals) - Math.min(...arrivals) < 60_000);
  assert.equal(f.runs().length, 0, 'eligible finishes defer check reservation to selection');
  await f.drain();
  assert.equal(f.runs().length, 1);
  const run = f.runs()[0];
  assert.equal(run.gate.mode, 'full');
  assert.equal(new Set(states(f).map(s => s.batchId)).size, 1);
  assert(states(f).every(s => s.phase === 'checking'));
  const oldMain = f.currentMain();
  await f.passChecks();
  const [holder, waiter] = states(f);
  const parked = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === waiter.id,
  );
  const orderWait = { submissionId: holder.id, held: 'accepting', footprints: 'overlap' };
  f.patch('projectHostedLandingRequests', parked._id, {
    orderWait: holder.id,
    orderWaits: [{ ...orderWait, at: f.now() - 4_250 }],
  });
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.tables.projectHostedAcceptances.size, 4);
  const accepted = [...f.tables.projectHostedAcceptances.values()];
  const receipts = accepted.map(r => JSON.parse(r.value));
  const waited = receipts.find(receipt => receipt.submissionId === waiter.id);
  assert.deepEqual(waited.orderWaits, [{ ...orderWait, seconds: 4.25 }]);
  assert.deepEqual(
    accepted.map(r => r.checkReused),
    [false, false, false, false],
    'a fresh shared check is not reuse',
  );
  assert(receipts.every(r => r.check.runId === run.id && r.candidate.head === run.request.expectedHead));
  assert(receipts.every(r => r.previous.head === oldMain.head));
  assert.deepEqual(
    receipts.map(r => r.submissionId),
    f.entries.map(e => e.state.id),
  );
  assert.equal(f.currentMain().head, run.request.expectedHead);
  assert.deepEqual(
    f.publications,
    [{ receipts: 4, mainMoves: 1, landed: 4 }],
    'all receipts and the main CAS commit in one transaction',
  );
  const finalFiles = JSON.parse(f.c.objects.get(f.currentMain().head)).files.map(f => f.path);
  for (let i = 0; i < 4; i++) assert(finalFiles.includes(`member-${i}`));
  for (const entry of f.entries) assert.equal((await f.readLane(entry.lane.laneId)).state, 'completed');
  for (const entry of f.entries) assert.equal((await f.enqueue(entry.request)).phase, 'landed');
  assert.equal(f.runs().length, 1, 'original-operation replay starts no checks');
  assert.equal(f.pending().length, 0);
  assert.deepEqual(
    spendLines,
    [['FORGE_ACCEPTED_LANDINGS 4']],
    'one numeric line for all four receipts, none on replay',
  );
});

test('a failed batch checks both halves at once; a culprit retains its own named test', async t => {
  const f = await batchesFixture(t);
  const runOf = i =>
    [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === f.entries[i].state.id)
      .runId;
  const settle = async () => {
    for (const run of f.runs().filter(r => r.status === 'queued')) {
      if (run.id === runOf(1)) await f.fail(run.id);
      else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    await f.drain();
  };
  await f.drain();
  await f.fail(f.runs()[0].id, 'tests/combined.test.mjs');
  await f.drain();
  const halves = f.runs().filter(r => r.status === 'queued');
  assert.equal(halves.length, 2, 'both halves compose and check in parallel');
  assert(
    states(f).every(s => !s.batchSolo),
    'halves are cohorts, not serial singles',
  );
  await settle();
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 2, 'the good half lands');
  for (let i = 0; i < 4 && states(f).some(s => s.phase === 'checking'); i++) await settle();
  assert.equal(states(f).filter(s => s.phase === 'checking').length, 0);
  // One batch, two halves, two singles of the failed half; the passing single
  // checked on the old main rechecks once on main including the good half.
  assert.equal(f.runs().length, 6);
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  const single = receipts.find(r => r.submissionId === f.entries[0].state.id);
  assert.equal(
    single.previous.head,
    receipts.find(r => r.submissionId === f.entries[2].state.id).candidate.head,
  );
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  const failed = states(f).find(s => s.phase === 'terminal-failed');
  assert.equal(failed.id, f.entries[1].state.id);
  assert.match(failed.error.message, /tests\/member-1.test.mjs/);
  assert(!JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'member-1'));
  assert.equal(f.pending().length, 0);
});

test('one member compose conflict is retained without blocking the rest or adding checks', async t => {
  const f = await batchesFixture(t, { conflict: true });
  await f.drain();
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const selected = await f.c.progress({ request: { operationId: batch.composeOperationId } });
  const fixed = await f.c.compute(selected.input);
  assert.equal(
    fixed.head,
    f.runs()[0].request.expectedHead,
    'fixed and stepped workers stack identical source',
  );
  assert.deepEqual(JSON.parse(fixed.manifest).dropped, selected.state.dropped);
  assert.equal(f.runs().length, 1);
  await f.passChecks();
  await f.drain();
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  const failed = states(f).find(s => s.phase === 'terminal-failed');
  assert.equal(failed.error.code, 'COMPOSITION_CONFLICT');
  const pins = JSON.parse(
    [...f.tables.projectHostedLandingAttempts.values()].find(r => r.attemptId === failed.attemptId).value,
  );
  assert.equal(pins.candidate.head, null, 'member has its own resolvable conflict Candidate');
  assert.match(failed.error.message, /conflict/i);
  assert.equal(f.runs().length, 1);
});

test('governance eligibility preserves supervised, contributor and protected-path review', () => {
  const candidate = {
    kind: 'candidate',
    result: { status: 'clean' },
    governance: { paths: ['src/a.ts'], ownerInputs: true },
  };
  const project = { owner: 'owner', visibility: 'public' },
    actor = { id: 'owner', kind: 'agent' };
  assert(batchEligible(project, policyPreset('trusted'), actor, candidate));
  assert(!batchEligible(project, policyPreset('supervised'), actor, candidate));
  assert(!batchEligible(project, policyPreset('trusted'), { ...actor, id: 'contributor' }, candidate));
  assert(!batchEligible(project, policyPreset('trusted'), actor, { ...candidate, governance: undefined }));
  assert(
    !batchEligible(project, policyPreset('trusted'), actor, {
      ...candidate,
      governance: { paths: ['.github/workflows/a.yml'], ownerInputs: false },
    }),
  );
  assert(!batchEligible(project, policyPreset('trusted'), { ...actor, kind: 'person' }, candidate));
});

test('cancellation during the shared check cannot publish the cancelled member', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  const shared = f.runs()[0];
  const runRow = [...f.tables.projectHostedCheckRuns.values()].find(row => row.runId === shared.id);
  const dispatch = Date.parse(shared.at);
  f.patch('projectHostedCheckRuns', runRow._id, {
    replayClock: { dispatchedAt: dispatch, startedAt: dispatch + 1000 },
  });
  await f.transaction('batch-cancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: f.entries[1].state.id,
    }),
  });
  const cancelled = states(f).find(s => s.id === f.entries[1].state.id);
  const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === cancelled.attemptId,
  );
  assert.equal(attempt.replay.censor, 'LANDING_CANCELLED');
  assert.equal(attempt.replay.check.runId, shared.id);
  assert.deepEqual(
    attempt.replay.check.predictedBase ?? JSON.parse(attempt.value).main,
    shared.candidate.base,
  );
  assert.equal(attempt.replay.check.startedAt - attempt.replay.check.dispatchedAt, 1000);
  await f.passChecks();
  await f.drain();
  assert.equal(
    states(f).filter(s => s.phase === 'landed').length,
    0,
    'checked stack containing a cancelled member is never published',
  );
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  assert.equal(states(f).find(s => s.id === f.entries[1].state.id).error.code, 'LANDING_CANCELLED');
  assert(!JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'member-1'));
});

test('a main receipt race recomposes the whole cohort without transferring evidence or splitting checks', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const checkedHead = f.runs()[0].request.expectedHead;
  const moved = f.moveMain();
  await f.passChecks();
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.currentMain().head, moved.head);
  assert.notEqual(f.runs().find(r => r.status === 'queued').request.expectedHead, checkedHead);
  for (let i = 0; i < 4; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 2);
  assert(states(f).every(s => !s.batchSolo));
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert(receipts.every(r => r.check.runId !== f.runs()[0].id));
  assert.equal(new Set(receipts.map(r => r.check.runId)).size, 1);
  assert(JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'accepted.txt'));
  // c3c69c57: every fork onto a moved main names its reason.
  assertForkRacesNamed(f, 'cohort');
});

for (const firstSeconds of [undefined, 480])
  test(`a cohort main race carries ${firstSeconds === undefined ? 'unknown' : 'shared, reported'} discarded usage once per member`, async t => {
    compactDiscardedChecks(t);
    const f = await batchesFixture(t);
    await f.drain();
    const [first] = f.runs();
    f.moveMain();
    await f.passChecks();
    if (firstSeconds !== undefined) stampExecution(f, first.id, firstSeconds);
    await f.drain();
    const replacement = f.runs().find(run => run.status === 'queued');
    assert.notEqual(replacement.id, first.id);
    await f.passChecks();
    stampExecution(f, replacement.id, 1200);
    await f.drain();
    for (const state of states(f)) {
      assert.equal(state.phase, 'landed');
      const cost = landingCosts(state, 1);
      assert.equal(cost.runnerAccepted, 5);
      assert.equal(cost.runnerDiscarded, firstSeconds === undefined ? null : 2);
      assert.equal(
        state.counts.discardedRunnerUnknown,
        firstSeconds === undefined ? 'superseded-check-execution-unreported' : undefined,
      );
    }
  });

test('a replaced check attempt starts with empty progress, not the previous attempt test counts (9f94c28a)', async t => {
  const f = await batchesFixture(t, { count: 4 });
  await f.drain();
  const first = f.runs()[0];
  const before = states(f).map(s => s.attemptId);
  f.moveMain();
  const active = await f.rawChecks.activate(first.id);
  for (let i = 0; i < active.plan.shardCount; i++) await f.rawChecks.callback(f.rawChecks.shard(active, i));
  await f.rawChecks.callback(
    f.rawChecks.complete(active, 'passed', {
      contractReports: {
        'tests/a.test.mjs': { failed: false, durationMs: 1 },
        'tests/b.test.mjs': { failed: false, durationMs: 1 },
      },
    }),
  );
  // Step the queue: the old attempt reports its counts, then main replaces it.
  let counted = false;
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 100, 'bounded');
    await f.execute(f.pending()[0]);
    const now = states(f);
    if (now.every((s, i) => s.attemptId === before[i])) counted ||= now.some(s => s.testFiles);
  }
  assert(counted, 'the replaced attempt reported test counts to its members');
  const now = states(f);
  assert(
    now.every((s, i) => s.attemptId !== before[i]),
    'main moved: every member got a new attempt',
  );
  for (const state of now) {
    assert.equal(state.testFiles, undefined, 'a new attempt carries no counts from the replaced one');
    assert.equal(state.checkProgress, undefined, 'a new attempt carries no progress digest');
  }
});

test('a changed supervised policy returns every passing member to individual review', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('supervised') });
  await f.passChecks();
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert(states(f).some(s => s.observation.pendingReason === 'waiting-for-review'));
  assert.equal(f.pending().length, 0);
});

test('an unrelated protected-path edit keeps the exact shared check usable', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  const [run] = f.runs();
  const project = f.tables.hostedProjects.get(f.projectId);
  const policy = project.autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      acceptance: { ...policy.acceptance, protectedPaths: ['unrelated/**'] },
    },
  });
  await f.passChecks();
  await f.drain();
  assert(states(f).every(state => state.phase === 'landed'));
  assert.deepEqual(
    f.runs().map(run => run.id),
    [run.id],
  );
  assert.deepEqual(f.publications, [{ receipts: 4, mainMoves: 1, landed: 4 }]);
});

async function batchUploadFixture(t) {
  const f = await batchesFixture(t);
  const batch = () => JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  while (!f.tables.projectHostedLandingBatches.size) await f.execute(f.pending()[0]);
  const leader = batch().leaderId ?? batch().id;
  for (let step = 0; step < 12; step++) {
    const task = f.pending().find(task => isFinishWake(task.name) && task.args[0].submissionId === leader);
    assert(task, 'batch metadata step remains resumable');
    if (task.name === 'projectHostedFinishDriver:drive') {
      const missing = batch().uploads.filter(upload => !f.c.objects.has(upload.pin.sha256));
      assert.equal(missing.length, 2, 'cold dependency and plan; the empty page is already stored');
      return {
        f,
        batch,
        task,
        missing,
        binding: ({ pin }) => [...f.tables.projectObjects.values()].find(row => row.digest === pin.sha256),
      };
    }
    await f.execute(task);
  }
  assert.fail('the one metadata drive did not start');
}

test('lost batch upload replies replay the same generation without duplicate source jobs or checks', async t => {
  const { f, batch, task, missing, binding } = await batchUploadFixture(t);
  const operation = batch().composeOperationId;
  await assert.rejects(f.execute(task, 'before-resume'), /synthetic crash after upload/);
  assert(
    missing.every(({ pin }) => f.c.objects.has(pin.sha256)),
    'one drive wrote both exact objects',
  );
  assert(
    missing.every(upload => !binding(upload).r2Committed),
    'no binding is published before resume',
  );
  assert.equal(f.runs().length, 0);
  const compose = [...f.tables.projectHostedComposes.values()].find(row => row.operationId === operation);
  assert.deepEqual([...f.tables.projectSourceSteps.values()], [], 'no source work before resume');
  await f.drain();
  assert.equal(batch().composeOperationId, operation);
  assert(missing.every(upload => binding(upload).r2Committed));
  assert.deepEqual(
    [...new Set([...f.tables.projectSourceSteps.values()].map(step => step.jobId))],
    [compose.jobId],
  );
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
});

test('a missing cohort metadata HEAD publishes neither binding and retries the original group', async t => {
  const { f, batch, task, missing, binding } = await batchUploadFixture(t);
  const operation = batch().composeOperationId;
  const fetch = globalThis.fetch;
  let missingHead = true;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (missingHead && init?.method === 'HEAD' && new URL(url).pathname.endsWith(missing[1].pin.sha256))
      return new Response(null, { status: 404 });
    return fetch(url, init);
  });
  await assert.rejects(f.execute(task), error => error.code === 'R2_OBJECT_MISSING');
  assert(missing.every(upload => !binding(upload).r2Committed));
  assert.equal(f.runs().length, 0);
  missingHead = false;
  await f.drain();
  assert.equal(batch().composeOperationId, operation);
  assert(missing.every(upload => binding(upload).r2Committed));
  assert.equal(f.runs().length, 1);
});

test('a single-upload drive cannot acknowledge a grouped command across deploys', async t => {
  const { f, batch, task, missing, binding } = await batchUploadFixture(t);
  const input = task.args[0];
  const raw = await f.transaction('batch-step', driver.step, input);
  const command = JSON.parse(raw);
  const index = batch().uploadIndex;
  const first = missing[0];
  f.c.objects.set(first.pin.sha256, Buffer.from(first.value)); // the old drive only verified this PUT
  await f.transaction('old-batch-callback', driver.resume, {
    ...input,
    command: raw,
    key: binding(first).r2Key,
  });
  assert.equal(batch().uploadIndex, index);
  assert(missing.every(upload => !binding(upload).r2Committed));
  assert.equal(f.runs().length, 0);
  // A command produced *before* deployment still advances exactly its old pointer.
  const next = batch().uploads[index];
  const { batchUpload, ...oldPlan } = command;
  assert.equal(batchUpload.from, index);
  f.c.objects.set(next.pin.sha256, Buffer.from(next.value));
  await f.transaction('old-batch-callback', driver.resume, {
    ...input,
    command: JSON.stringify({ ...oldPlan, ...next }),
    key: binding(next).r2Key,
  });
  const coldIndex = index + 1;
  assert.equal(batch().uploadIndex, coldIndex);
  assert(missing.every(upload => !binding(upload).r2Committed));
  const leaderWake = (name, wakeId) =>
    f
      .pending()
      .find(
        task =>
          task.name === name &&
          task.args[0].submissionId === input.submissionId &&
          (!wakeId || task.args[0].wakeId === wakeId),
      );
  const settle = leaderWake('projectHostedFinishDriver:settle');
  await f.execute(settle);
  const live = leaderWake('projectHostedFinishDriver:drive', settle.args[0].wakeId).args[0];
  const current = JSON.parse(await f.transaction('batch-step', driver.step, live));
  const { batchUpload: currentWindow, ...coldLegacyPlan } = current;
  assert.equal(currentWindow.from, coldIndex);
  const groupedReply = {
    ...live,
    command: JSON.stringify(current),
    key: binding(first).r2Key,
    page: JSON.stringify(missing.map(upload => upload.pin.sha256)),
  };
  for (const stale of [
    { ...current, batchComposeOperationId: randomUUID() },
    { ...current, batchUpload: { ...currentWindow, from: index } },
  ]) {
    await f.transaction('stale-batch-callback-with-current-wake', driver.resume, {
      ...groupedReply,
      command: JSON.stringify(stale),
    });
    assert.equal(batch().uploadIndex, coldIndex);
    assert(missing.every(upload => !binding(upload).r2Committed));
    assert.equal(leaderWake('projectHostedFinishDriver:retry').args[0].wakeId, live.wakeId);
  }
  await f.transaction('legacy-cold-batch-callback', driver.resume, {
    ...live,
    command: JSON.stringify(coldLegacyPlan),
    key: binding(first).r2Key,
  });
  assert.equal(batch().uploadIndex, coldIndex + 1);
  assert.equal(binding(first).r2Committed, true, 'legacy completion commits the cold pin');
  assert(!binding(missing[1]).r2Committed, 'legacy completion advances only its own pin');
  await f.drain();
  assert(missing.every(upload => binding(upload).r2Committed));
  await f.transaction('delayed-grouped-callback', driver.resume, groupedReply);
  assert.equal(f.pending().length, 0, 'a stale reply cannot replace the current wake');
  assert.equal(f.runs().length, 1);
});

test('urgent work arriving during a cohort upload can still reselect before dispatch', async t => {
  const { f, batch, task, missing, binding } = await batchUploadFixture(t);
  const operation = batch().composeOperationId;
  const fetch = globalThis.fetch;
  let urgent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.method === 'PUT' && new URL(url).pathname.endsWith(missing[0].pin.sha256)) {
      urgent = await f.enqueue(f.request({ priority: 'urgent', agent: false }));
    }
    return fetch(url, init);
  });
  await f.execute(task);
  assert.equal(urgent?.priority, 'urgent', 'the arrival happens during the grouped action');
  assert(
    missing.every(upload => binding(upload).r2Committed),
    'both verified bindings commit together',
  );
  assert.equal(batch().phase, 'composing');
  const stillReady = () =>
    [...f.tables.projectHostedComposes.values()].some(
      row => row.operationId === operation && JSON.parse(row.value).status === 'ready',
    );
  assert(stillReady(), 'the callback does not dispatch the now lower-priority cohort');
  const settle = f
    .pending()
    .find(next => isFinishWake(next.name) && next.args[0].submissionId === (batch().leaderId ?? batch().id));
  assert(settle, 'the original leader is scheduled to reconsider');
  await f.execute(settle);
  assert.equal(batch().phase, 'superseded');
  assert(stillReady(), 'reselection did not start the superseded compose');
});

test('changed exact run pins cannot authorize any shared publication', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.request.expectedHead = 'e'.repeat(64);
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(run) });
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert(
    f.runs().some(r => r.status === 'queued'),
    'members retain an exact single fallback',
  );
  const transition = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value).transition;
  assert(transition?.code && transition.message, 'retain the structured failure that caused fallback');
  assert(
    states(f).every(
      state =>
        state.batchDiagnostic?.message.includes(transition.code) &&
        state.batchDiagnostic.message.includes(transition.message),
    ),
    'report the retained internal cause through the released diagnostic message',
  );
  for (let i = 0; i < 4; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed'));
});

test('a completed unreported cohort remains unknown after its members fall back to solo checks', async t => {
  compactDiscardedChecks(t);
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  for (let step = 0; states(f).some(state => state.phase !== 'ready'); step++) {
    assert(step < 40, 'the shared verdict becomes ready before the policy changes');
    await f.execute(f.pending()[0]);
  }
  const policy = policyPreset('trusted');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, landing: 'serial' } },
  });
  await f.drain();
  assert(
    states(f).every(
      state => state.counts?.discardedRunnerUnknown === 'superseded-check-execution-unreported',
    ),
  );
  for (let wave = 0; states(f).some(state => state.phase !== 'landed'); wave++) {
    assert(wave < 8, 'the individual replacements reach acceptance');
    const queued = f.runs().filter(run => run.status === 'queued');
    assert(queued.length);
    await f.passChecks();
    for (const run of queued) stampExecution(f, run.id, 300);
    await f.drain();
  }
  for (const state of states(f)) {
    const cost = landingCosts(state, 1);
    assert.equal(cost.runnerAccepted, 5);
    assert.equal(cost.runnerDiscarded, null);
  }
});

test('formation reads two indexed windows, takes eight members and leaves overflow runnable', async t => {
  const f = await batchesFixture(t, { count: 9 });
  const { batchStore } = await import('./hosted-landing-batches-fixture.mjs');
  const { store } = await import('./hosted-landing-fixture.mjs');
  let windows = 0;
  await f.transaction(
    'batch-formation-budget',
    {
      _handler: async ctx => {
        const input = { projectId: f.projectId, submissionId: f.entries[0].state.id };
        const selected = await store.loadLanding(ctx, input),
          query = ctx.db.query.bind(ctx.db);
        ctx.db.query = table => {
          const value = query(table),
            withIndex = value.withIndex.bind(value);
          value.withIndex = (name, builder) => {
            if (
              table === 'projectHostedLandingRequests' &&
              name === 'by_project_channel_runnable_batchable_priority_sequence'
            )
              windows++;
            return withIndex(name, builder);
          };
          return value;
        };
        assert(await batchStore.formLandingBatch(ctx, input, selected));
      },
    },
    {},
  );
  assert.equal(windows, 2);
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.members.length, 8);
  const overflow = [...f.tables.projectHostedLandingRequests.values()].find(
    r => r.submissionId === f.entries[8].state.id,
  );
  assert.equal(overflow.runnable, true);
  assert.equal(JSON.parse(overflow.value).batchId, undefined);
});

test('seven arrivals pipeline on a checking solo without replacing its proof or rechecking', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await f.drain();
  const originalRun = f.runs()[0];
  assert.equal(states(f)[0].phase, 'checking');
  for (let i = 1; i < 8; i++) {
    const base = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const head = f.c.state([...base.files, f.c.file(`member-${i}`, `member ${i}`)], [f.c.baseline.sha256]);
    const lane = await f.c.lane(head),
      selection = f.c.selection([lane]);
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const row of f.tables[table].values())
        if (row.kind === 'lane' && row.key === lane.laneId) f.patch(table, row._id, { ownerOnly: true });
    const candidate = await compose(f.c, selection);
    await f.enqueue(
      f.request({
        governanceVersion: 1,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
  }
  await f.drain();
  assert.equal(f.tables.projectHostedLandingBatches.size, 1, 'successor composes while the solo checks');
  assert.equal(f.runs().length, 2, 'successor checks on the predicted predecessor');
  await f.rawChecks.pass(await f.rawChecks.activate(originalRun.id));
  await f.drain();
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.members.length, 7);
  assert.equal(f.runs().length, 2);
  assert.equal(f.runs()[0].id, originalRun.id);
  const originalMain = f.currentMain().head;
  const shared = f.runs().find(run => run.id !== originalRun.id);
  assert.equal(shared.candidate.base.head, originalMain, 'next cohort checks on its accepted predecessor');
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert.equal(receipts.filter(r => r.check.runId === originalRun.id).length, 1);
  assert.equal(receipts.filter(r => r.check.runId === shared.id).length, 7);
  assert.equal(f.runs().length, 2, 'eight landings need two full checks total');
  assert.equal(f.pending().length, 0);
});

test('server-verified governance batches legacy clients without a new protocol step', async t => {
  const f = await batchesFixture(t, { count: 2, governanceVersion: null });
  assert(states(f).every(s => s.request.governanceVersion === undefined));
  await f.drain();
  assert.equal(f.runs().length, 1);
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
});

test('a stacked changed-path manifest larger than 4 KiB passes the real source finalizer grant', async t => {
  const f = await batchesFixture(t, { count: 4, fileCount: 500 });
  const { moduleUrl } = await import('./convex-module.mjs');
  const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
  const composed = async () => {
    for (const step of f.tables.projectSourceSteps?.values() ?? []) {
      const job = await f.transaction(
        'batch-compose-job',
        { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, step.jobId) },
        {},
      );
      if (job.jobKind === 'compose' && job.output) return job;
    }
    return null;
  };
  let task, job;
  for (let i = 0; i < 100; i++) {
    task = f.pending().find(task => task.name === 'projectHostedComposeJobs:complete');
    if (task || (job = await composed())) break;
    await f.execute(f.pending()[0]);
  }
  if (task) {
    const { jobApi } = await import('./hosted-compose-fixture.mjs');
    const grant = await f.transaction('batch-result-download', jobApi.resultDownload, task.args[0]);
    assert(grant.size > 4096 && grant.size <= 512 * 1024);
  } else {
    // Up to 64 KiB, the step's terminal commit publishes its own result text (1eef1b43).
    assert(job, 'source completion is event driven');
    assert(job.output.size > 4096 && job.output.size <= 64 * 1024);
    assert(!f.pending().some(task => /^projectHostedComposeJobs:(complete|publish)$/.test(task.name)));
  }
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
});

test('incident storage replay: eight eligible landings reuse a stored empty page and share one check', async t => {
  const f = await batchesFixture(t, { count: 8 });
  const { buildComposePages } = await import('../dist/hosted-compose.js');
  const { saveBytes } = await import('../dist/hosted-save.js');
  const page = buildComposePages([]).pages[0];
  const pin = f.c.put(saveBytes(page.value));
  await f.drain();
  assert.equal(f.runs().length, 1);
  assert(states(f).every(s => !s.batchSolo && s.phase === 'checking'));
  assert.equal(
    [...f.tables.projectObjects.values()].find(row => row.digest === pin.sha256).location,
    'r2',
    'valid stored bytes keep their existing location',
  );
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
  assert.equal(f.pending().length, 0);
});

test('overflow pipelines a one-member group on the checking eight-member cohort', async t => {
  const f = await batchesFixture(t, { count: 9 });
  await f.drain();
  assert.equal(f.runs().length, 2);
  const [first, next] = f.runs();
  assert.equal(next.candidate.base.head, first.request.expectedHead);
  await f.rawChecks.pass(await f.rawChecks.activate(first.id));
  await f.drain();
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 8);
  assert.equal(next.candidate.base.head, f.currentMain().head);
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 2);
  assert.equal(f.pending().length, 0);
});

test('a main advance during shared composition recomposes before reserving a full check', async t => {
  const f = await batchesFixture(t, { count: 8 });
  while (![...f.tables.projectHostedComposes.values()].some(row => JSON.parse(row.value).batch))
    await f.execute(f.pending()[0]);
  const moved = f.moveMain();
  await f.drain();
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].candidate.base.head, moved.head);
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1, 'an obsolete source plan does not consume a check');
});

test('a terminal finish error releases its active cohort through an event without waiting for an alarm', async t => {
  const f = await batchesFixture(t, { count: 9 });
  await f.drain();
  const { moduleUrl } = await import('./convex-module.mjs');
  const finish = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
  // Simulate a terminal source/controller error, outside normal check settlement.
  for (const member of f.entries.slice(0, 8))
    await f.transaction(
      'terminal-cohort-error',
      {
        _handler: ctx =>
          finish.failFinish(
            ctx,
            { projectId: f.projectId, submissionId: member.state.id },
            'SOURCE_UNAVAILABLE',
            'synthetic terminal source error',
          ),
      },
      {},
    );
  for (const task of f.pending())
    if (task.name === 'projectHostedLandingStall:alarm')
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
  await f.drain();
  assert.equal(
    f.runs().length,
    3,
    'the speculative overflow is discarded and checks surviving main after its predecessor fails',
  );
  assert.equal(f.runs().at(-1).candidate.base.head, f.currentMain().head);
  await f.passChecks();
  await f.drain();
  assert.equal(states(f).find(s => s.id === f.entries[8].state.id).phase, 'landed');
  assert.equal(f.pending().length, 0);
});

for (const legacy of [false, true])
  test(`non-batchable owner work can settle while an eligible cohort checks (${legacy ? 'legacy' : 'current'} projection)`, async t => {
    const f = await batchesFixture(t, { count: 8 });
    await f.drain();
    const shared = f.runs()[0];
    const base = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const head = f.c.state(
      [...base.files, f.c.file('src/owner-work.ts', 'owner change')],
      [f.c.baseline.sha256],
    );
    const lane = await f.c.lane(head),
      selection = f.c.selection([lane]);
    const candidate = await compose(f.c, selection);
    const state = await f.enqueue(
      f.request({
        agent: false,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
    if (legacy) {
      const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
      f.patch('projectHostedLandingRequests', row._id, { batchable: undefined });
    }
    const own = f.runs().find(r => r.id !== shared.id);
    assert(own, 'ordinary non-batchable work keeps its existing check reservation');
    await f.rawChecks.pass(await f.rawChecks.activate(own.id));
    await f.drain();
    assert.equal(
      states(f).find(s => s.id === state.id).phase,
      'landed',
      'an eligible checking cohort never holds ordinary non-batchable publication',
    );
    assert.equal(
      f.runs().find(r => r.id === shared.id).status,
      'queued',
      'the cohort check did not need to finish first',
    );
    await f.passChecks();
    await f.drain();
    await f.passChecks();
    await f.drain();
    assert(states(f).every(s => s.phase === 'landed'));
    assert.equal(f.runs().length, 3, 'one external main advance requires one shared cohort recheck');
    assert.equal(f.pending().length, 0);
  });

test('urgent non-batchable owner work bypasses older normal work while a cohort checks', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const shared = f.runs()[0],
    entries = [];
  for (const priority of ['normal', 'urgent']) {
    const base = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const head = f.c.state(
      [...base.files, f.c.file(`src/outside-${priority}.ts`, priority)],
      [f.c.baseline.sha256],
    );
    const lane = await f.c.lane(head),
      selection = f.c.selection([lane]);
    const candidate = await compose(f.c, selection);
    const state = await f.enqueue(
      f.request({
        agent: false,
        priority,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
    entries.push({ state, candidate });
  }
  const urgent = f.runs().find(run => run.request.candidateId === entries[1].candidate.id);
  await f.rawChecks.pass(await f.rawChecks.activate(urgent.id));
  await f.drain();
  assert.equal(states(f).find(s => s.id === entries[1].state.id).phase, 'landed');
  assert.notEqual(states(f).find(s => s.id === entries[0].state.id).phase, 'landed');
  assert.equal(f.runs().find(run => run.id === shared.id).status, 'queued');
});

test('priority bypass reads bounded heads with 1150 earlier non-batchable normal arrivals', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const template = [...f.tables.projectHostedLandingRequests.values()][0];
  for (let i = 0; i < 1150; i++)
    seedTicket(f, {
      ...template,
      _id: undefined,
      _creationTime: undefined,
      submissionId: randomUUID(),
      sequence: i + 20,
      batchable: false,
      priority: 'normal',
      runnable: true,
      value: '{"unrelated":"normal bodies must not be hydrated"}',
    });
  const urgent = randomUUID();
  seedTicket(f, {
    ...template,
    _id: undefined,
    _creationTime: undefined,
    submissionId: urgent,
    sequence: 2000,
    batchable: undefined,
    priority: 'urgent',
    runnable: true,
    value: '{"unrelated":"only the exact selected head is needed"}',
  });
  const { moduleUrl } = await import('./convex-module.mjs');
  const wake = await import(moduleUrl('../convex/projectHostedLandingWake.ts'));
  const { store } = await import('./hosted-landing-fixture.mjs');
  const before = f.counts.length;
  await f.transaction(
    'priority-bypass-budget',
    {
      _handler: async ctx => {
        const queue = await store.landingQueue(ctx, { projectId: f.projectId, channel: 'main' });
        const row = await wake.nextTrainLandingRow(ctx, queue);
        assert.equal(row.submissionId, urgent);
      },
    },
    {},
  );
  assert.equal(f.counts.length - before, 1);
  const count = f.counts.at(-1);
  assert(
    count.documents - landingBodyCounts(count).reads <= 16 &&
      count.ranges - landingBodyCounts(count).ranges <= 16,
    JSON.stringify(count),
  );
  t.diagnostic(
    JSON.stringify({
      normalBacklog: 1150,
      calls: 1,
      documents: count.documents,
      ranges: count.ranges,
      readBytes: count.readBytes,
    }),
  );
});

test('an exhausted shared source job fails its original cohort without allocating fallback compositions', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { exhaustSourceExecution } = await import(moduleUrl('../convex/projectConvexSourceFailure.ts'));
  const f = await batchesFixture(t);
  for (let i = 0; !f.tables.projectSourceSteps.size; i++) {
    assert(i < 40);
    await f.execute(f.pending()[0]);
  }
  const step = [...f.tables.projectSourceSteps.values()][0];
  const jobs = f.tables.projectSourceSteps.size,
    composes = f.tables.projectHostedComposes.size;
  await f.tx(
    'exhaustSharedSource',
    {
      _handler: ctx =>
        exhaustSourceExecution(ctx, step, {
          stage: 'source-headers',
          exception: 'TimeoutError',
          code: null,
          elapsedMs: 15000,
          httpStatus: null,
        }),
    },
    {},
  );
  await f.drain();
  assert(
    states(f).every(
      state => state.phase === 'terminal-failed' && state.error.code === 'SOURCE_RETRY_EXHAUSTED',
    ),
  );
  assert.equal(f.tables.projectSourceSteps.size, jobs);
  assert.equal(f.tables.projectHostedComposes.size, composes);
  assert.equal(f.runs().length, 0);
  assert.equal(f.pending().length, 0);
});
