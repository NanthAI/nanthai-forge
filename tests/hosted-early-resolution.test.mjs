// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictTrio, resolveEarly, drainReady, totals } from './early-resolution-replay.mjs';
import { synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { syncRequiredAdvice, syncRequiredContinuation } from '../dist/hosted-would-conflict.js';
import { randomUUID } from 'node:crypto';
import { earlyResolutionChoice } from '../dist/early-resolution.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('Automatic compares measured predecessor failure with project resolution/wait break-even, cold start resolves early', () => {
  assert.equal(earlyResolutionChoice(undefined).early, true);
  assert.equal(earlyResolutionChoice('off').early, false);
  assert.equal(earlyResolutionChoice('on', [[randomUUID(), false, 1, 100]]).early, true);
  const samples = [true, true, true, false].map(passed => [randomUUID(), passed, 75, 225]);
  assert.equal(earlyResolutionChoice('automatic', samples).breakEven, 0.25);
  assert.equal(
    earlyResolutionChoice('automatic', samples).early,
    false,
    'equality does not favor early work',
  );
  assert.equal(earlyResolutionChoice('automatic', [...samples, [randomUUID(), true, 75, 225]]).early, true);
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

test('setting off reports exact conflict, measured facts and an optional resolve without changing the canonical wait', async t => {
  const { f, advice } = await conflictTrio(t, { earlyResolve: 'off' });
  assert.equal(advice.resolution.early, false);
  assert.equal(syncRequiredAdvice(advice), undefined);
  assert.match(advice.next, /failure rate.*wait saved.*off.*choose sync/s);
  assert(advice.next.includes(`predecessor Lane ${f.entries[1].lane.laneId}`), 'name the conflicting Lane');
  assert(!/No agent action/i.test(advice.next));
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

test('Automatic waits when measured failures exceed break-even, and continues observing healthy predecessors', async t => {
  const samples = [false, false, false, true].map(passed => [randomUUID(), passed, 75000, 225000]);
  const { f, advice } = await conflictTrio(t, { samples });
  assert.equal(advice.resolution.early, false);
  assert.equal(advice.resolution.failureRate, 0.75);
  assert.equal(advice.resolution.breakEven, 0.25);
  assert.match(advice.next, /3.75 minutes/);
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  const observed = JSON.parse([...f.tables.projectHostedLandingQueues.values()][0].earlyResolveSamples);
  assert(observed.length > samples.length, 'waiting does not freeze the measured outcome window');
  assert(
    observed.slice(samples.length).every(sample => sample[1]),
    'healthy predecessors enter the same window',
  );
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

test('a predecessor that settles before resolution finishes still supplies measured resolution/wait receipts', async t => {
  const trio = await conflictTrio(t);
  const resolved = await resolveEarly(trio, {
    beforeResolve: async () => {
      for (const run of trio.f.runs().filter(r => r.status === 'queued')) {
        await trio.f.rawChecks.pass(await trio.f.rawChecks.activate(run.id));
        await drainReady(trio.f);
      }
    },
  });
  const samples = JSON.parse([...trio.f.tables.projectHostedLandingQueues.values()][0].earlyResolveSamples);
  const measured = samples.find(sample => sample[0] === resolved.predecessor.receiptId);
  assert.equal(measured[1], true);
  assert(measured[2] >= 75000, 'completed author resolution fills the previously unknown cost');
  assert(measured[3] >= 0);
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
