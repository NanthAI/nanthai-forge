// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, synthetic, states, batchStore } from './hosted-landing-batches-fixture.mjs';
import { drainReady } from './early-resolution-replay.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { compose, isFinishWake } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { syncRequiredAdvice } from '../dist/hosted-would-conflict.js';
const desired = await import(moduleUrl('../convex/projectHostedLandingDesired.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const live = f => states(f).filter(s => !['landed', 'terminal-failed'].includes(s.phase));
async function fixture(t, laneActor, { earlyResolve } = {}) {
  const f = await batchesFixture(t, {
    count: 0,
    batchMaxSize: 1,
    baselineFiles: [['shared.txt', 'alpha\nmiddle\nomega\n']],
    memberPaths: ['shared.txt', 'shared.txt', 'shared.txt'],
    memberContents: ['alpha-a\nmiddle\nomega\n', 'alpha-b\nmiddle\nomega\n', 'alpha-c\nmiddle\nomega\n'],
  });
  if (earlyResolve) {
    const { autonomyPolicy } = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...autonomyPolicy, acceptance: { ...autonomyPolicy.acceptance, earlyResolve } },
    });
  }
  await f.add(0);
  await drainReady(f);
  if (laneActor) f.insert('projectContributors', { projectId: f.projectId, contributor: laneActor });
  await f.add(1, laneActor ? { lane: { actor: laneActor } } : {});
  await drainReady(f);
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  return { f, s };
}
async function finishResolution(f, s, source, skip) {
  const pending = (await s.readLane(source.lane.laneId)).entry;
  const files = JSON.parse(f.c.objects.get(pending.head)).files;
  const edited = await s.save(
    pending,
    files.map(file => (file.path === 'shared.txt' ? f.c.file(file.path, 'alpha-ab\nmiddle\nomega\n') : file)),
  );
  const resolved = (
    await s.execute(s.request('resolve', { laneId: edited.laneId, expected: s.pins(edited) }))
  ).terminal.outcome.result;
  const lane = (await s.readLane(resolved.lane.laneId)).entry;
  const selection = f.c.selection([lane]);
  selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
  const candidate = await compose(f.c, selection);
  const state = await f.enqueue(
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      expectedMain: selection.request.expectedMain,
      governanceVersion: 1,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  await drainReady(f, skip);
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f, skip);
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  return { lane, state };
}

test('8c9b84fc: conflicting main sync supersedes an ownerless submission before its resolution lands', async t => {
  const { f, s } = await fixture(t);
  const original = f.entries[1];
  // Reproduce the retained incident boundary: accepted conflicting survivor, original requeued in
  // a composing cohort, with its leader drive lost and no advice. No synthetic source result.
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    r => r.submissionId === original.state.id,
  );
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  // Let the survivor publish, but drop the child's drive before it can recompose.
  for (let n = 0; n < 100; n++) {
    const task = f
      .pending()
      .find(
        t =>
          !/LandingStall|CheckLease:expire/.test(t.name) &&
          !(isFinishWake(t.name) && t.args[0].submissionId === original.state.id),
      );
    if (!task) break;
    await f.execute(task);
  }
  const key = {
    projectId: f.projectId,
    batchId: JSON.parse(f.tables.projectHostedLandingRequests.get(row._id).value).batchId,
  };
  await f.transaction(
    'requeue-without-consumed-compose-result',
    {
      _handler: async ctx => {
        await batchStore.retryLandingBatch(ctx, key, (await batchStore.loadBatch(ctx, key)).batch);
      },
    },
    {},
  );
  for (const task of f
    .pending()
    .filter(
      t => t.name === 'projectHostedFinishDriver:drive' && t.args[0].submissionId === original.state.id,
    ))
    f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
  const retryCommand = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: original.selection.request.operationId,
    after: null,
    check: original.request.check,
  };
  const retried = JSON.parse(
    await f.tx('retry-lost-cohort', desired.submit, {
      projectId: f.projectId,
      request: JSON.stringify(retryCommand),
    }),
  );
  assert.equal(retried.phase, 'composing', 'ownerless retry admits a new desired operation');
  const source = (
    await s.execute(
      s.request('sync', {
        laneId: original.lane.laneId,
        expected: s.pins(original.lane),
        target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
      }),
    )
  ).terminal.outcome.result;
  assert.equal(source.status, 'conflict');
  const ended = (await f.current(original.state.id)).submission;
  assert.equal(ended.phase, 'terminal-failed', 'conflicting sync must end every old live finish');
  assert.equal(ended.error.code, 'LANDING_SUPERSEDED');
  const pendingRetry = JSON.parse(
    [...f.tables.projectHostedLandingDesired.values()].find(r => r.submissionId === retried.id).value,
  );
  assert.equal(
    pendingRetry.phase,
    'terminal-failed',
    'the sync also ends source-preparing requests for the same head',
  );
  assert.equal(pendingRetry.error.code, 'LANDING_SUPERSEDED');
  assert.equal(live(f).length, 0);
  await finishResolution(f, s, source);
  assert.equal(live(f).length, 0, 'the entire lineage is terminal after acceptance');
  assert(!states(f).some(s => s.error?.code === 'EVIDENCE_CHANGED'));
  assert.equal(f.pending().length, 0);
});

function markSyncRequired(f, submission, laneId) {
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === submission.id,
  );
  f.patch('projectHostedLandingRequests', row._id, {
    wouldConflict: JSON.stringify({
      paths: ['shared.txt'],
      more: 0,
      landedSubmissionId: f.entries[0].state.id,
      ...(laneId ? { laneId } : {}),
      at: submission.at,
      next: 'Sync required',
    }),
  });
}

async function replaySyncRequiredHandoff(t, target) {
  const { f, s } = await fixture(t);
  const original = f.entries[1];
  await f.add(2);
  const unrelated = f.entries[2];
  const skip = task =>
    isFinishWake(task.name) && [original.state.id, unrelated.state.id].includes(task.args[0].submissionId);
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drainReady(f, skip);
  // Seed the accepted-main advice on both queued entries so the replay covers the handoff transition.
  for (const entry of [original, unrelated]) markSyncRequired(f, entry.state, entry.lane.laneId);
  const before = await f.current(unrelated.state.id);
  assert.equal(before.submission.phase, 'queued');
  assert.equal(before.wouldConflict?.laneId, unrelated.lane.laneId);
  assert.equal((await f.current(original.state.id)).wouldConflict?.laneId, original.lane.laneId);
  const main = f.currentMain();
  let request;
  if (target === 'conflict draft') {
    const selection = f.c.selection([original.lane]);
    selection.request.expectedMain = { head: main.head, receiptId: main.receipt.id };
    const candidate = await compose(f.c, selection);
    assert.equal(candidate.result.status, 'conflict');
    // A same-Intent Lane can be named as the origin, but its different head is absent from this draft.
    await s.execute(
      s.request('resolution', {
        candidateId: candidate.id,
        conflicts: candidate.result.conflicts,
        originLaneId: unrelated.lane.laneId,
      }),
    );
    assert.deepEqual((await f.current(unrelated.state.id)).submission, before.submission);
    request = s.request('resolution', {
      candidateId: candidate.id,
      conflicts: candidate.result.conflicts,
      originLaneId: original.lane.laneId,
    });
  } else {
    const candidate = f.entries[0].candidate;
    request = s.request('sync', {
      laneId: original.lane.laneId,
      expected: s.pins(original.lane),
      target:
        target === 'main'
          ? { kind: 'main', head: main.head, receiptId: main.receipt.id }
          : { kind: 'candidate', candidateId: candidate.id, head: candidate.result.head },
    });
  }
  await s.prepareSync(request);
  await s.submitSync(request);
  const output = await s.workSync(request);
  assert.equal((await f.current(original.state.id)).submission.phase, 'queued');
  const callsBeforePublish = f.counts.length;
  const receipt = await s.publishSync(output);
  const publish = f.counts.slice(callsBeforePublish).find(call => call.name === 'syncPublish');
  t.diagnostic(JSON.stringify({ reads: publish.documents, writes: publish.writes }));
  const source = receipt.outcome.result;
  assert.equal(source.status, 'conflict');
  assert.notEqual(source.lane.laneId, original.lane.laneId);
  assert.equal(source.resolution.origin.laneId, original.lane.laneId);
  const ended = (await f.current(original.state.id)).submission;
  assert.equal(ended.phase, 'terminal-failed');
  assert.equal(ended.error.code, 'LANDING_SUPERSEDED');
  assert.ok(ended.error.message.includes(source.lane.laneId), 'the entry names its resolution Lane');
  assert.equal(ended.observation.state, 'superseded');
  assert.deepEqual((await f.current(unrelated.state.id)).submission, before.submission);

  const readsBeforeRetry = f.counts.length;
  assert.deepEqual(await s.publishSync(output), receipt);
  assert.equal(
    f.counts.slice(readsBeforeRetry).reduce((sum, call) => sum + call.writes, 0),
    0,
  );
  assert.deepEqual((await f.current(original.state.id)).submission, ended);
  assert.deepEqual((await f.current(unrelated.state.id)).submission, before.submission);
}

test('39a68046: a main handoff retires only the origin queued sync-required entry at publication', t =>
  replaySyncRequiredHandoff(t, 'main'));
test('39a68046: a candidate handoff retires only the origin queued sync-required entry at publication', t =>
  replaySyncRequiredHandoff(t, 'candidate'));
test('39a68046: a conflict draft retires only the origin queued sync-required entry at publication', t =>
  replaySyncRequiredHandoff(t, 'conflict draft'));

test('39a68046: a single-Lane handoff preserves headless older and multi-Lane submissions', async t => {
  const { f, s } = await fixture(t, undefined, { earlyResolve: 'off' });
  const original = f.entries[1];
  const olderSelection = [...f.tables.projectHostedComposeSelections.values()].find(
    row => row.operationId === original.selection.request.operationId && row.key === original.lane.laneId,
  );
  // Replay the pre-029138ef index format. The older Candidate's manifest still pins its actual head.
  f.patch('projectHostedComposeSelections', olderSelection._id, { head: undefined });
  const files = JSON.parse(f.c.objects.get(original.lane.head)).files;
  const newer = await s.save(original.lane, [...files, f.c.file('newer.txt', 'newer save')]);
  const sibling = await f.c.lane(
    f.c.state(
      [...JSON.parse(f.c.objects.get(f.c.baseline.sha256)).files, f.c.file('sibling.txt', 'sibling work')],
      [f.c.baseline.sha256],
    ),
  );
  const selection = f.c.selection([newer, sibling]);
  const combined = await compose(f.c, selection);
  assert.equal(combined.result.status, 'clean');
  const aggregate = await f.enqueue(
    f.request({
      candidateId: combined.id,
      expectedHead: combined.result.head,
      expectedMain: selection.request.expectedMain,
      governanceVersion: 1,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  const protectedIds = [original.state.id, aggregate.id];
  const skip = task => isFinishWake(task.name) && protectedIds.includes(task.args[0].submissionId);
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drainReady(f, skip);
  markSyncRequired(f, original.state, original.lane.laneId);
  markSyncRequired(f, aggregate);
  const before = await Promise.all(protectedIds.map(f.current));
  for (const entry of before) {
    assert.equal(entry.submission.phase, 'queued');
    assert.ok(syncRequiredAdvice(entry.wouldConflict));
  }
  const target = f.entries[0].candidate;
  const { terminal } = await s.execute(
    s.request('sync', {
      laneId: newer.laneId,
      expected: s.pins(newer),
      target: { kind: 'candidate', candidateId: target.id, head: target.result.head },
    }),
  );
  assert.equal(terminal.outcome.result.status, 'conflict');
  assert.equal(terminal.outcome.result.resolution.origin.head, newer.head);
  for (const entry of before)
    assert.deepEqual((await f.current(entry.submission.id)).submission, entry.submission);
});

test('8c9b84fc: a clean main sync preserves a live submission', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await drainReady(f);
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  const original = f.entries[0];
  await s.execute(
    s.request('sync', {
      laneId: original.lane.laneId,
      expected: s.pins(original.lane),
      target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
    }),
  );
  assert.equal((await f.current(original.state.id)).submission.phase, 'checking');
});

test('8c9b84fc: a same-selection retry replaces a queued submission with no armed owner', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await drainReady(f);
  const entry = f.entries[0],
    row = [...f.tables.projectHostedLandingRequests.values()][0];
  const state = JSON.parse(row.value);
  state.phase = 'queued';
  state.observation = { state: 'pending', pendingReason: 'queued', cause: null };
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'queued',
    runnable: false,
    batchId: undefined,
    value: JSON.stringify({ ...state, batchId: undefined }),
  });
  for (const r of f.tables.projectHostedFinishes.values()) {
    f.patch('projectHostedFinishes', r._id, { wake: null, composeOperationId: null });
  }
  const command = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: entry.selection.request.operationId,
    after: null,
    check: entry.request.check,
    retryReason: 'other',
  };
  const replacement = JSON.parse(
    await f.tx('retry-ownerless-selection', desired.submit, {
      projectId: f.projectId,
      request: JSON.stringify(command),
    }),
  );
  assert.notEqual(replacement.id, entry.state.id);
  assert.equal((await f.current(entry.state.id)).submission.error.code, 'LANDING_SUPERSEDED');
});

test('8c9b84fc: full voided-cell replay retires every operation and maintains one live submission per lineage', async t => {
  const { legacySideBranch } = await import('./early-resolution-legacy-fixture.mjs');
  const { readLandingTransition } = await import('../dist/hosted-landing.js');
  const { ticketState } = await import('./landing-ticket-fixture.mjs');
  const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
  const { f, s, lane, selection, state, run, request } = await legacySideBranch(t);
  const assertAlarmOwners = stage => {
    for (const task of f.pending().filter(t => t.name === 'projectHostedLandingStall:alarm')) {
      const owners = [
        ...f.tables.projectHostedLandingRequests.values(),
        ...f.tables.projectHostedLandingDesired.values(),
      ].filter(r => r.submissionId === task.args[0].submissionId);
      assert(
        owners.some(r => r.alarm?.taskId === task._id),
        `${stage}: orphan alarm ${task._id} for ${task.args[0].submissionId}`,
      );
    }
  };
  assertAlarmOwners('legacy setup');
  const active = await f.rawChecks.activate(run.id);
  const skipChild = task => isFinishWake(task.name) && task.args[0].submissionId === state.id;
  for (const other of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(other.id));
    await drainReady(f, skipChild);
    assertAlarmOwners('predecessor accepted');
  }
  assert.equal(
    (await f.current(state.id)).submission.phase,
    'queued',
    'survivor acceptance cancelled the obsolete side-branch check',
  );
  await assert.rejects(f.rawChecks.pass(active), e => (e.data?.code ?? e.code) === 'CHECK_CANCELLED');
  const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === state.id);
  f.patch('_scheduled_functions', finish.wake.taskId, { state: { kind: 'failed' } });
  const retry = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: selection.request.operationId,
    after: null,
    check: request.check,
  };
  const joined = JSON.parse(
    await f.tx('replay-land-with-retry', desired.submit, {
      projectId: f.projectId,
      request: JSON.stringify(retry),
    }),
  );
  assertAlarmOwners('retried');
  const source = (
    await s.execute(
      s.request('sync', {
        laneId: lane.laneId,
        expected: s.pins(lane),
        ontoMain: true,
        target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
      }),
    )
  ).terminal.outcome.result;
  assert.equal(source.status, 'conflict');
  const older = (await f.current(state.id)).submission;
  assert.equal(
    older.phase,
    'terminal-failed',
    'the old operation must be terminal no later than sync publish',
  );
  assert.equal(older.error.code, 'LANDING_SUPERSEDED');
  const resolved = await finishResolution(f, s, source);
  for (const operationId of [f.entries[2].request.operationId, request.operationId, retry.operationId]) {
    const receipt = JSON.parse(
      await f.tx('terminal-lineage-receipt', observe.page, {
        projectId: f.projectId,
        operationId,
        nextVersion: 0,
        priorityInfo: 1,
      }),
    );
    assert(['landed', 'terminal-failed'].includes(receipt.submission.phase), JSON.stringify(receipt));
    assert.notEqual(receipt.submission.error?.code, 'EVIDENCE_CHANGED');
  }
  assert.equal(live(f).length, 0);
  assert(
    [...f.tables.projectHostedLandingDesired.values()].every(r =>
      ['landed', 'terminal-failed'].includes(JSON.parse(r.value).phase),
    ),
  );
  assert.equal(
    f.pending().length,
    0,
    JSON.stringify(
      f.pending().map(t => ({
        name: t.name,
        input: t.args[0],
        state: [
          ...f.tables.projectHostedLandingRequests.values(),
          ...f.tables.projectHostedLandingDesired.values(),
        ]
          .filter(r => r.submissionId === t.args[0].submissionId)
          .map(r => ({
            phase: JSON.parse(r.value).phase,
            alarm: r.alarm,
            origin: r.submissionId === state.id,
            retry: r.submissionId === joined.id,
          })),
      })),
    ),
  );
  // Replay every retained production transition as the finite lineage model, including the
  // superseded original and its continuation through an isolated resolution Lane.
  const origin = new Map([[resolved.lane.laneId, lane.laneId]]);
  const selections = new Map();
  for (const row of f.tables.projectHostedComposeSelections.values())
    if (row.kind === 'inputs')
      selections.set(row.operationId, [...(selections.get(row.operationId) ?? []), row.key]);
  const latest = new Map();
  let transitions = 0;
  for (const event of f.tables.projectHostedLandingObservations.values()) {
    const row = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === event.submissionId,
    );
    const current = readLandingTransition(event.value, ticketState(f, row)).submission;
    latest.set(current.id, current);
    const byLineage = new Map();
    for (const entry of latest.values()) {
      if (['landed', 'terminal-failed'].includes(entry.phase)) continue;
      for (const laneId of new Set(selections.get(entry.request.finish?.composeOperationId) ?? [])) {
        const root = origin.get(laneId) ?? laneId;
        byLineage.set(root, (byLineage.get(root) ?? 0) + 1);
      }
    }
    assert(
      [...byLineage.values()].every(n => n <= 1),
      `lineage invariant at transition ${transitions}`,
    );
    transitions++;
  }
  t.diagnostic(
    JSON.stringify({
      transitions,
      original: older.phase,
      retry: joined.phase,
      allOperationsTerminal: true,
      idle: f.pending().length,
    }),
  );
});

test('8c9b84fc: an authorized peer main sync supersedes none of the Lane actor work', async t => {
  const { f, s } = await fixture(t, 'contributor');
  const original = f.entries[1];
  const skip = task => isFinishWake(task.name) && task.args[0].submissionId === original.state.id;
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drainReady(f, skip);
  const before = (await s.readLane(original.lane.laneId)).entry;
  const source = (
    await s.execute(
      s.request('sync', {
        laneId: before.laneId,
        expected: s.pins(before),
        target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
      }),
    )
  ).terminal.outcome.result;
  assert.equal(source.status, 'conflict');
  assert.equal(
    (await f.current(original.state.id)).submission.phase,
    'queued',
    'a peer sync does not retire the Lane actor work',
  );
  const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
  await f.tx('withdraw-peer-negative-fixture', api.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: original.state.id,
    }),
  });
  await drainReady(f);
  assert.equal(f.pending().length, 0);
});

test('8c9b84fc: accepting a directly composed resolution supersedes the origin as a completion backstop', async t => {
  const { f, s } = await fixture(t, undefined, { earlyResolve: 'off' });
  const original = f.entries[1];
  const skip = task => isFinishWake(task.name) && task.args[0].submissionId === original.state.id;
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  // The backstop still covers work whose advice has not arrived when the draft publishes.
  await drainReady(f, task => skip(task) || task.name === 'projectHostedLandingWouldConflict:mark');
  assert.equal(syncRequiredAdvice((await f.current(original.state.id)).wouldConflict), undefined);
  const selection = f.c.selection([original.lane]);
  selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
  const candidate = await compose(f.c, selection);
  assert.equal(candidate.result.status, 'conflict');
  const source = (
    await s.execute(
      s.request('resolution', {
        candidateId: candidate.id,
        conflicts: candidate.result.conflicts,
        originLaneId: original.lane.laneId,
      }),
    )
  ).terminal.outcome.result;
  assert.equal((await f.current(original.state.id)).submission.phase, 'queued');
  await finishResolution(f, s, source, skip);
  const ended = (await f.current(original.state.id)).submission;
  assert.equal(ended.phase, 'terminal-failed');
  assert.equal(ended.error.code, 'LANDING_SUPERSEDED');
  assert.equal(f.pending().length, 0);
});
