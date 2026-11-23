// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictTrio, resolveEarly, drainReady, totals } from './early-resolution-replay.mjs';
import { synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { syncRequiredAdvice, syncRequiredContinuation } from '../dist/hosted-would-conflict.js';
import { randomUUID } from 'node:crypto';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('conflict trio resolves once on the last exact predecessor, checks before it lands, accepts only its exact receipt', async t => {
  const trio = await conflictTrio(t);
  const { f, advice, current } = trio;
  assert(advice?.resolution?.early, JSON.stringify(advice));
  assert.equal(advice.predecessor.submissionId, current(1).id, 'choose the last predecessor of the chain');
  assert.deepEqual(advice.paths, ['shared.txt']);
  assert(advice.next.includes(`predecessor Lane ${f.entries[1].lane.laneId}`), 'name the conflicting Lane');
  assert(!/No agent action/i.test(advice.next));
  const action = syncRequiredContinuation('/synthetic/project', syncRequiredAdvice(advice));
  assert.equal(action.next.action, 'sync');
  assert.equal(action.next.predecessor.head, advice.predecessor.head);
  const resolved = await resolveEarly(trio);
  const checked = f.runs().find(run => run.request.expectedHead === resolved.candidate.result.head);
  assert(checked, 'the resolved Lane owns a check before either predecessor lands');
  await f.rawChecks.pass(await f.rawChecks.activate(checked.id));
  await drainReady(f);
  assert.notEqual((await f.current(resolved.state.id)).submission.phase, 'landed');
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  const landed = (await f.current(resolved.state.id)).submission;
  assert.equal(landed.phase, 'landed', JSON.stringify(landed));
  const receipt = [...f.tables.projectHostedAcceptances.values()]
    .map(r => JSON.parse(r.value))
    .find(r => r.submissionId === landed.id);
  assert.equal(receipt.check.runId, checked.id);
  assert.equal(receipt.candidate.head, checked.request.expectedHead);
  assert.equal(receipt.previous.receiptId, advice.predecessor.receiptId);
  assert.equal(
    f.runs().length,
    3,
    'one exact check per author; resolution does not spend an extra speculative check',
  );
  t.diagnostic(JSON.stringify(totals(f)));
});

for (const outcome of ['failed', 'withdrawn', 'head-change', 'receipt-change'])
  test(`early-resolved predecessor ${outcome} restores author source, retires its check and fences a late pass`, async t => {
    const { moduleUrl } = await import('./convex-module.mjs');
    const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
    const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
    const { randomUUID } = await import('node:crypto');
    const trio = await conflictTrio(t);
    const { f, s, advice } = trio;
    const resolved = await resolveEarly(trio);
    const run = f.runs().find(run => run.request.expectedHead === resolved.candidate.result.head);
    const active = await f.rawChecks.activate(run.id);
    if (outcome === 'failed') {
      const parent = f.runs().find(run => run.request.expectedHead === advice.predecessor.head);
      await f.fail(parent.id, 'tests/member-1.test.mjs');
      await drainReady(f);
    } else if (outcome === 'withdrawn') {
      await f.tx('withdraw-early-predecessor', api.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          submissionId: advice.predecessor.submissionId,
        }),
      });
      await drainReady(f);
    } else {
      await f.transaction(
        'change-early-predecessor-generation',
        {
          _handler: async ctx => {
            const current = await store.loadLanding(ctx, {
              projectId: f.projectId,
              submissionId: advice.predecessor.submissionId,
            });
            const old = await store.loadLandingAttempt(ctx, {
              projectId: f.projectId,
              attemptId: current.state.attemptId,
            });
            const next = {
              ...old,
              id: randomUUID(),
              parentAttemptId: old.id,
              number: old.number + 1,
              candidate: {
                ...old.candidate,
                head: outcome === 'head-change' ? 'e'.repeat(64) : old.candidate.head,
              },
              operations: { ...old.operations, accept: randomUUID() },
            };
            await store.insertLandingAttempt(ctx, next);
            await store.writeLanding(
              ctx,
              current.row,
              { ...current.state, attemptId: next.id, version: current.state.version + 1 },
              false,
            );
          },
        },
        {},
      );
      await drainReady(f);
    }
    const restored = (await s.readLane(resolved.lane.laneId)).record;
    assert.equal(
      restored.head,
      resolved.original.head,
      'the active Lane contains only the original author source',
    );
    assert.equal(restored.earlyResolution, undefined);
    assert(f.c.objects.has(resolved.lane.head), 'every prior speculative State remains retained');
    const state = (await f.current(resolved.state.id)).submission;
    assert.equal(state.phase, 'terminal-failed', JSON.stringify(state));
    assert.equal(state.error.code, 'STACK_PARENT_CHANGED');
    assert(
      f.runs().find(r => r.id === run.id).cancelRequested ||
        f.runs().find(r => r.id === run.id).status === 'cancelled',
    );
    await assert.rejects(
      f.rawChecks.pass(active),
      error => (error.data?.code ?? error.code) === 'CHECK_CANCELLED',
    );
    await drainReady(f);
    assert.equal((await f.current(resolved.state.id)).submission.phase, 'terminal-failed');
    assert(
      ![...f.tables.projectHostedAcceptances.values()].some(row => row.submissionId === resolved.state.id),
    );
    assert.equal(f.currentMain().head, f.c.baseline.sha256, 'no unaccepted predecessor content reached main');
  });

test('setting off reports exact conflict and optional pinned sync and an optional resolve without changing the canonical wait', async t => {
  const { f, advice, lateEntry } = await conflictTrio(t, { earlyResolve: 'off' });
  assert.equal(advice.resolution.early, false);
  assert.equal(syncRequiredAdvice(advice), undefined);
  assert.match(advice.next, /off.*choose sync/s);
  assert(advice.next.includes(`predecessor Lane ${f.entries[1].lane.laneId}`), 'name the conflicting Lane');
  assert(!/No agent action/i.test(advice.next));
  // 577927f1: the recommended wait is a command an agent can run, on this landing's own operation.
  const wait = `Run: nforge agent . wait '{"operationIds":["${lateEntry.state.operationId}"]}'.`;
  assert(advice.next.includes(`keep waiting: if it lands`) && advice.next.includes(wait), advice.next);
  assert(advice.next.indexOf(wait) < advice.next.indexOf('Or choose sync'), 'the recommendation comes first');
  // ...and what waiting leads to either way (a failed predecessor releases the follower: queued-conflict-precheck C1).
  assert(advice.next.includes('if it fails, this landing goes on without it.'), advice.next);
  // Line 1: the provisional source, the exact predecessor and what happens if it fails.
  const { head, receiptId } = advice.predecessor;
  assert(advice.next.includes(`A resolution made now is provisional: it is built on predecessor Lane`));
  assert(advice.next.includes(`(State ${head}, receipt ${receiptId}) and lands only after that lands`));
  assert(advice.next.includes('If it fails or is replaced, this Lane goes back to its own last save'));
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  assert.equal((await f.current(f.entries[2].state.id)).submission.error.code, 'COMPOSITION_CONFLICT');
});

test('a clean overlap keeps the existing predicted-head checks and exact acceptance, with no conflict action', async t => {
  const { f, advice } = await conflictTrio(t, { clean: true });
  assert.equal(advice, undefined);
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(f.runs().length, 3);
  assert.equal(f.pending().length, 0);
});

test('a saved early resolution without its own submission still loses rejected predecessor bytes', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
  const trio = await conflictTrio(t);
  const resolved = await resolveEarly(trio, { submit: false });
  await trio.f.tx('withdraw-before-child-submit', api.cancel, {
    projectId: trio.f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: resolved.predecessor.submissionId,
    }),
  });
  await drainReady(trio.f);
  const lane = (await trio.s.readLane(resolved.lane.laneId)).record;
  assert.equal(lane.head, resolved.original.head);
  assert.equal(lane.earlyResolution, undefined);
  assert(trio.f.c.objects.has(resolved.lane.head));
});

test('a predecessor that settles before resolution finishes does not regain a dependent event link', async t => {
  const trio = await conflictTrio(t);
  const resolved = await resolveEarly(trio, {
    beforeResolve: async () => {
      for (const run of trio.f.runs().filter(r => r.status === 'queued')) {
        await trio.f.rawChecks.pass(await trio.f.rawChecks.activate(run.id));
        await drainReady(trio.f);
      }
    },
  });
  const dependent = [...trio.f.tables.projectHostedStackDependents.values()].find(
    r => r.laneId === resolved.lane.laneId,
  );
  assert.equal(dependent?.predecessorId, undefined);
  assert.equal([...trio.f.tables.projectHostedLandingQueues.values()][0].earlyResolveSamples, undefined);
});

test('three checking predecessors yield one resolution against the final exact prefix', async t => {
  const trio = await conflictTrio(t, { thirdPredecessor: true });
  assert.equal(trio.advice.predecessor.submissionId, trio.current(3).id);
  const resolved = await resolveEarly(trio);
  assert.equal(trio.f.runs().length, 4);
  for (const run of trio.f.runs().filter(r => r.status === 'queued')) {
    await trio.f.rawChecks.pass(await trio.f.rawChecks.activate(run.id));
    await drainReady(trio.f);
  }
  assert.equal((await trio.f.current(resolved.state.id)).submission.phase, 'landed');
  assert.equal(trio.f.runs().length, 4);
});

test('a predecessor withdrawn during sync IO settles the original source operation without publishing a stale draft', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
  const { f, s, advice, lateEntry } = await conflictTrio(t);
  const { groupId: _group, ...predecessor } = advice.predecessor;
  void _group;
  const request = s.request('sync', {
    laneId: lateEntry.lane.laneId,
    expected: s.pins(lateEntry.lane),
    predecessor,
    target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
  });
  await s.prepareSync(request);
  await s.submitSync(request);
  const output = await s.workSync(request);
  await f.tx('withdraw-during-early-sync', api.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: predecessor.submissionId,
    }),
  });
  const terminal = await s.publishSync(output);
  assert.equal(terminal.outcome.status, 'failed');
  assert.equal(terminal.outcome.error.code, 'STACK_PARENT_CHANGED');
  assert.deepEqual(
    (await s.progressSync(request)).terminal,
    terminal,
    'the original operation is terminal and replayable',
  );
  assert.equal((await s.readLane(lateEntry.lane.laneId)).entry.head, lateEntry.lane.head);
});

test('revoking a child author cannot block predecessor withdrawal or preserve rejected source in the active child', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
  const { syncFixture } = await import('./hosted-sync-fixture.mjs');
  const trio = await conflictTrio(t);
  const { f } = trio;
  const grant = f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const original = await f.c.lane(
    { sha256: trio.lateEntry.lane.head, size: f.c.objects.get(trio.lateEntry.lane.head).length },
    { actor: 'contributor' },
  );
  const s = await syncFixture({
    store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args, 'contributor') },
  });
  const resolved = await resolveEarly({ ...trio, s, lateEntry: { lane: original } }, { submit: false });
  await drainReady(f); // Settle the helper's direct source-job deliveries before revocation.
  // Invalidate the fake's per-table equality index through its ordinary transaction writer.
  await f.transaction('revoke-early-child', { _handler: ctx => ctx.db.delete(grant) }, {});
  await f.tx('withdraw-after-child-revocation', api.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: resolved.predecessor.submissionId,
    }),
  });
  await drainReady(f);
  const restored = (await trio.s.readLane(resolved.lane.laneId)).record;
  assert.equal(restored.head, original.head);
  assert.equal(restored.actor, 'contributor', 'rollback does not change source ownership');
  assert.equal(restored.earlyResolution, undefined);
});

test('an exact predecessor with mixed provenance never promotes the early resolution to owner-only source', async t => {
  const { f, s, advice, lateEntry } = await conflictTrio(t);
  const parent = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === advice.predecessor.submissionId,
  );
  const attempt = JSON.parse(
    [...f.tables.projectHostedLandingAttempts.values()].find(row => row.attemptId === parent.attemptId).value,
  );
  for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
    for (const row of f.tables[table].values())
      if (row.kind === 'candidate' && row.key === attempt.candidate.id)
        f.patch(table, row._id, { ownerOnly: false });
  const { groupId: _group, ...predecessor } = advice.predecessor;
  void _group;
  const prepared = await s.prepareSync(
    s.request('sync', {
      laneId: lateEntry.lane.laneId,
      expected: s.pins(lateEntry.lane),
      predecessor,
      target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
    }),
  );
  assert.equal(prepared.state.ownerInputs, false);
});

test('8c9b84fc: accepted prefix clears its dependent link before and after a late resolve', async t => {
  const trio = await conflictTrio(t);
  const { f } = trio;
  const pin = trio.advice.predecessor;
  await resolveEarly(trio, {
    submit: false,
    beforeResolve: async () => {
      for (const run of f.runs().filter(r => r.status === 'queued')) {
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
        await drainReady(f);
      }
      assert(
        ![...f.tables.projectHostedStackDependents.values()].some(r => r.predecessorId === pin.submissionId),
        'acceptance releases the event link even before resolutionEndedAt exists',
      );
    },
  });
  assert(
    ![...f.tables.projectHostedStackDependents.values()].some(r => r.predecessorId === pin.submissionId),
    'publishing the later resolution cannot leak the accepted predecessor link again',
  );
});

test('8c9b84fc: a third overlapping clean group preserves the resolved landing check through acceptance', async t => {
  const { replayLinearConflictTrio } = await import('./early-resolution-replay.mjs');
  const replay = await replayLinearConflictTrio(t);
  t.diagnostic(JSON.stringify(replay));
  assert.equal(replay.childChecks.length, 1, 'the resolved landing must not check twice');
  assert.equal(replay.acceptedCheck, replay.childChecks[0]);
  assert.equal(replay.lateTaskMs, 360000);
  assert.equal(replay.checks, 4, 'each of four landed changes checks once');
  assert.equal(replay.idle, 0);
});

test('8c9b84fc: a third group conflicting with the resolution yields compose advice before any child check', async t => {
  const trio = await conflictTrio(t, { lateThird: true });
  const { f } = trio;
  const resolved = await resolveEarly(trio, {
    resolvedContents: 'alpha-ac\nmiddle-c\nomega-bc\n',
    beforeResolve: async () => {
      await f.add(3);
      await drainReady(f);
    },
  });
  const child = await f.current(resolved.state.id);
  assert.equal(child.submission.phase, 'queued');
  assert.equal(child.wouldConflict.predecessor.submissionId, f.entries[3].state.id);
  const attempts = [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .filter(a => a.submissionId === resolved.state.id);
  assert(
    attempts.every(a => !a.check),
    'a known compose conflict never allocates a check to discard',
  );
  assert.equal(f.runs().length, 3);
});

test('8c9b84fc: an exact non-tail cohort member pin composes on its shared checked tail', async t => {
  const { batchesFixture } = await import('./hosted-landing-batches-fixture.mjs');
  const { syncFixture } = await import('./hosted-sync-fixture.mjs');
  const { moduleUrl } = await import('./convex-module.mjs');
  const pipeline = await import(moduleUrl('../convex/projectHostedLandingPipeline.ts'));
  const f = await batchesFixture(t, {
    count: 0,
    batchMaxSize: 2,
    baselineFiles: [['shared.txt', 'alpha\nmiddle\nomega\n']],
    memberPaths: ['shared.txt', 'root.txt', 'shared.txt'],
    memberContents: ['alpha-a\nmiddle\nomega\n', 'root', 'alpha-c\nmiddle\nomega\n'],
  });
  await f.add(0);
  await f.add(1);
  await drainReady(f);
  assert.equal(states(f)[0].batchId, states(f)[1].batchId);
  const first = states(f)[0];
  const attempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .find(a => a.id === first.attemptId);
  const pin = { submissionId: first.id, head: attempt.candidate.head, receiptId: attempt.operations.accept };
  const prefix = await f.transaction(
    'non-tail-exact-cohort-pin',
    {
      _handler: ctx =>
        pipeline.pipelinePredecessor(ctx, { projectId: f.projectId, channel: 'main' }, undefined, undefined, {
          pins: [pin],
        }),
    },
    {},
  );
  assert(prefix, 'the exact shared checked State contains every included member receipt');
  assert.equal(prefix.submissionId, states(f)[1].id);
  await f.add(2);
  await drainReady(f);
  const advice = { ...(await f.current(f.entries[2].state.id)).wouldConflict, predecessor: pin };
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  const resolved = await resolveEarly({ f, s, advice, lateEntry: f.entries[2] });
  assert.equal((await f.current(resolved.state.id)).submission.phase, 'checking');
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  assert.equal((await f.current(resolved.state.id)).submission.phase, 'landed');
  assert.equal(f.runs().length, 2);
  assert.equal(f.pending().length, 0);
});
