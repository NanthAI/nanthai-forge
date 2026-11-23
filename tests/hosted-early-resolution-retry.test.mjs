// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEarly, drainReady, totals } from './early-resolution-replay.mjs';
import { synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { internalConflict, legacySideBranch } from './early-resolution-legacy-fixture.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('8c9b84fc: internal cohort conflict resolves against its checked survivor, never the disjoint outer predecessor', async t => {
  const f = await internalConflict(t);
  const lateEntry = f.entries[2],
    peer = states(f).find(s => s.id === f.entries[1].state.id),
    advice = (await f.current(lateEntry.state.id)).wouldConflict;
  assert(advice?.resolution?.early);
  assert.equal(
    advice.predecessor.submissionId,
    peer.id,
    'the outer predecessor has no conflicting peer bytes',
  );
  const peerAttempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .find(a => a.id === peer.attemptId);
  assert.equal(advice.predecessor.head, peerAttempt.candidate.head);
  assert.equal(advice.predecessor.receiptId, peerAttempt.operations.accept);
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  const resolved = await resolveEarly({ f, s, advice, lateEntry });
  assert.equal(resolved.source.status, 'conflict', 'the advised exact State exposes the real conflict');
  const ownRun = f.runs().find(r => r.request.expectedHead === resolved.candidate.result.head);
  assert(ownRun, 'the resolved selection checks while its survivor is pending');
  await f.rawChecks.pass(await f.rawChecks.activate(ownRun.id));
  await drainReady(f);
  assert.notEqual((await f.current(resolved.state.id)).submission.phase, 'landed');
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  assert.equal((await f.current(resolved.state.id)).submission.phase, 'landed');
  assert(
    states(f).every(s => ['landed', 'terminal-failed'].includes(s.phase)),
    'no earlier operation survives the replacement landing',
  );
  assert.equal(f.runs().length, 3, 'root, survivor and resolved child each check once');
  assert.equal(f.pending().length, 0, 'no stranded queue binding or idle wake');
  t.diagnostic(JSON.stringify(totals(f)));
});

test('a retained legacy clean sync onto an older valid prefix still settles its superseded check after a conflicting survivor lands', async t => {
  const { f, state, run: childRun } = await legacySideBranch(t);
  await f.rawChecks.activate(childRun.id);
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  const terminal = (await f.current(state.id)).submission;
  assert.equal(terminal.phase, 'terminal-failed', JSON.stringify(terminal));
  assert.equal(terminal.error.code, 'COMPOSITION_CONFLICT', JSON.stringify(terminal));
  assert.equal(f.pending().length, 0);
});

for (const outcome of ['failed', 'withdrawn'])
  test(`internal survivor ${outcome} restores the early author's source and fences its check`, async t => {
    const { moduleUrl } = await import('./convex-module.mjs');
    const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
    const { randomUUID } = await import('node:crypto');
    const f = await internalConflict(t),
      lateEntry = f.entries[2];
    const advice = (await f.current(lateEntry.state.id)).wouldConflict;
    const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
    const resolved = await resolveEarly({ f, s, advice, lateEntry });
    const run = f.runs().find(r => r.request.expectedHead === resolved.candidate.result.head);
    const active = await f.rawChecks.activate(run.id);
    if (outcome === 'failed') {
      const peer = f.runs().find(r => r.request.expectedHead === advice.predecessor.head);
      await f.fail(peer.id, 'tests/shared.test.mjs');
    } else
      await f.tx('withdraw-internal-survivor', api.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          submissionId: advice.predecessor.submissionId,
        }),
      });
    await drainReady(f);
    const child = (await f.current(resolved.state.id)).submission;
    assert.equal(child.phase, 'terminal-failed');
    assert.equal(child.error.code, 'STACK_PARENT_CHANGED');
    assert.equal((await s.readLane(resolved.lane.laneId)).entry.head, resolved.original.head);
    await assert.rejects(f.rawChecks.pass(active), e => (e.data?.code ?? e.code) === 'CHECK_CANCELLED');
    assert(![...f.tables.projectHostedAcceptances.values()].some(r => r.submissionId === child.id));
  });

test('8c9b84fc: a pinned sync that merges cleanly keeps the original submission and Lane head', async t => {
  const f = await internalConflict(t);
  const root = states(f)[0],
    original = f.entries[2];
  const attempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .find(a => a.id === root.attemptId);
  const predecessor = {
    submissionId: root.id,
    head: attempt.candidate.head,
    receiptId: attempt.operations.accept,
  };
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  const before = (await s.readLane(original.lane.laneId)).record;
  const source = (
    await s.execute(
      s.request('sync', {
        laneId: original.lane.laneId,
        expected: s.pins(original.lane),
        predecessor,
        target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
      }),
    )
  ).terminal.outcome.result;
  assert.equal(source.status, 'up-to-date', 'a clean target is refused as an early-resolution target');
  assert.deepEqual((await s.readLane(original.lane.laneId)).record, before);
  assert.equal((await f.current(original.state.id)).submission.phase, 'queued');
  assert(![...f.tables.projectHostedStackDependents.values()].some(r => r.predecessorId === root.id));
  const rootRow = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === root.id);
  assert.equal(
    rootRow.earlyResolveWatch,
    undefined,
    'clean sync cannot add a cheap successful target sample',
  );
  for (const run of f.runs().filter(r => r.status === 'queued')) {
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  assert.equal(f.pending().length, 0);
  const samples = JSON.parse(
    [...f.tables.projectHostedLandingQueues.values()][0].earlyResolveSamples ?? '[]',
  );
  assert(!samples.some(sample => sample[0] === predecessor.receiptId));
});

test('8c9b84fc: an advice read error leaves the survivors checking', async t => {
  const f = await internalConflict(t, async f => {
    const peer = f.entries[1];
    await f.transaction(
      'lose-optional-advice-lane-name',
      {
        _handler: async ctx => {
          for (const row of f.tables.projectHostedComposeSelections.values())
            if (row.operationId === peer.selection.request.operationId) await ctx.db.delete(row._id);
        },
      },
      {},
    );
  });
  const survivor = (await f.current(f.entries[1].state.id)).submission;
  assert.equal(survivor.phase, 'checking');
  const batch = JSON.parse(
    [...f.tables.projectHostedLandingBatches.values()].find(r => r.batchId === survivor.batchId).value,
  );
  assert.equal(batch.phase, 'checking', 'advisory metadata never sends survivors into fallback');
  assert(f.runs().some(r => r.status === 'queued' && r.id === batch.runId));
});
