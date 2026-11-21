// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const queueView = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
const landings = await import(moduleUrl('../convex/projectHostedLandings.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const { claimReadyLanding } = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const stateOf = (f, id) => states(f).find(s => s.id === id);
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;
const attempts = (f, id) =>
  [...f.tables.projectHostedLandingAttempts.values()]
    .filter(row => row.submissionId === id)
    .map(row => ({ ...JSON.parse(row.value), progress: row.progress ? JSON.parse(row.progress) : null }))
    .sort((a, b) => a.number - b.number);
const PARKED_MS = 7.5 * 60_000;

/** Incident 19328518 counter-example (2026-11-07, operation 23938f96, receipt 68cc9092).
 * The revert composed and passed its check within 8 min of submission, then parked READY
 * behind an older submission (#752) still in its own recheck. For 7.6 min status showed
 * READY with no reason; the older landing's commit woke it, it recomposed and landed. Its
 * receipt then read compose start 15 min 38 s after submission (each attempt restamps
 * timing.composeStartedAt) and recomposeCount 0, so the wait read as a lost compose driver. */
async function orderWaitJourney(t, waitedMs, ending, { onStep, retryOlder = 0 } = {}) {
  const f = await batchesFixture(t, { count: 2, batching: false, requestCheck: true });
  const [older, newer] = f.entries.map(entry => entry.state);
  assert(older.sequence < newer.sequence);
  let seen = null,
    released = false;
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 400, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    const parked = [...f.tables.projectHostedLandingRequests.values()].find(row => row.orderWait);
    await onStep?.(f, parked);
    if (parked && !seen) {
      // Every reader names the wait: finish status, landing status and the observe page.
      const status = await f.current(newer.id);
      const landing = JSON.parse(
        await f.tx('landingStatus', landingApi.status, { projectId: f.projectId, submissionId: newer.id }),
      );
      const page = JSON.parse(
        await f.tx('observePage', observe.page, {
          projectId: f.projectId,
          operationId: newer.operationId,
          nextVersion: 0,
        }),
      );
      seen = { status, landing, page, olderStatus: await f.current(older.id), row: structuredClone(parked) };
      f.advanceClock(waitedMs);
      if (ending === 'claim') {
        const holder = [...f.tables.projectHostedLandingRequests.values()].find(
          r => r.submissionId === older.id,
        );
        f.patch('projectHostedLandingRequests', holder._id, { orderLive: undefined });
      }
      if (ending === 'failed' || ending === 'claim') {
        const claim = await f.transaction(
          'replay-ready-claim',
          {
            _handler: ctx =>
              claimReadyLanding(
                ctx,
                {
                  projectId: f.projectId,
                  channel: 'main',
                  submissionId: parked.submissionId,
                  attemptId: parked.attemptId,
                  owner: 'synthetic-claim',
                },
                undefined,
                false,
              ),
          },
          {},
        );
        if (ending === 'claim') {
          assert(claim?.token, 'the waiter claims acceptance when it no longer has a holder');
          return { f, older, newer, seen };
        }
        assert.equal(claim.waitingFor, older.id);
        assert.equal(f.counts.at(-1).writes, 0, 'a repeated claim adds no write or new start');
        assert.deepEqual(f.tables.projectHostedLandingRequests.get(parked._id).orderWaits, parked.orderWaits);
      }
      if (ending === 'withdrawn')
        await f.transaction('withdraw-parked-waiter', landingApi.cancel, {
          projectId: f.projectId,
          request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: newer.id }),
        });
    }
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      // The older check finishes only after the newer one has passed and parked.
      const holdsOrder = runOwner(f, run) === older.id;
      if (holdsOrder && !seen) continue;
      if (holdsOrder) released = true;
      if (holdsOrder && ending === 'failed') await f.fail(run.id);
      else {
        const active = await f.rawChecks.activate(run.id);
        if (holdsOrder && retryOlder > 0) {
          retryOlder--;
          await f.rawChecks.callback(f.rawChecks.complete(active, 'runner-unavailable'));
        } else await f.rawChecks.pass(active);
      }
    }
    const task = f.pending()[0];
    if (!task) break;
    await f.execute(task);
  }
  assert(seen, 'the newer passed entry parked behind the older one');
  assert(released);
  return { f, older, newer, seen };
}

test('replay 19328518: a parked passed landing names the older submission it waits for in every status read', async t => {
  const queued = new Map();
  let parkedCount;
  const { f, older, newer, seen } = await orderWaitJourney(t, PARKED_MS, 'landed', {
    // The older check binds two replacement runs to the same Candidate while the newer one waits.
    retryOlder: 2,
    async onStep(f, parked) {
      const live = states(f).filter(s => s.observation.state === 'pending');
      if (
        live.every(state => queued.get(state.id)?.attemptId === state.attemptId) &&
        (!parked || parkedCount !== undefined)
      )
        return;
      const reply = JSON.parse(await f.tx('queueView', queueView.read, { projectId: f.projectId }));
      for (const entry of reply.entries) {
        const state = live.find(s => s.id === entry.submissionId);
        if (state) queued.set(state.id, { attemptId: state.attemptId, count: entry.recomposeCount });
        if (entry.submissionId === parked?.submissionId && parkedCount === undefined)
          parkedCount = entry.recomposeCount;
      }
    },
  });
  for (const [name, value] of [
    ['finish status', seen.status],
    ['landing status', seen.landing],
    ['observe page', seen.page],
  ]) {
    assert.equal(value.orderWait?.submissionId, older.id, `${name} names the older submission`);
    assert.match(value.orderWait.message, /waiting for older submission .* to take main first/);
    // ad80e037: why it waits shows before it lands, as the receipt's orderWaits will record it.
    const last = seen.row.orderWaits.at(-1);
    assert.equal(last.submissionId, older.id);
    assert.equal(value.orderWait.held, last.held, `${name} names the hold reason`);
    assert.equal(value.orderWait.footprints, last.footprints, `${name} names the footprints`);
    assert(['overlap', 'disjoint', 'unknown'].includes(value.orderWait.footprints));
    const { at, ...publicWait } = last;
    assert(Number.isSafeInteger(at), 'the queue has a start clock');
    assert.deepEqual(value.orderWait.waits, [publicWait], `${name} lists the waits without internal clocks`);
    assert(value.orderWait.waits.length <= 8, 'bounded');
  }
  assert.equal(seen.olderStatus.orderWait, undefined, 'an entry that is not parked shows no order wait');
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.equal(stateOf(f, newer.id).acceptance && true, true);
  // After landing nothing is parked, so status no longer reports a wait.
  assert.equal((await f.current(newer.id)).orderWait, undefined);

  // The parked attempt ended for the older landing, and said so; the receipt read of
  // its stored rows (first compose, hold, recomposes) replays in hosted-landings-read.test.mjs.
  const chain = attempts(f, newer.id);
  assert.equal(new Set(chain.map(a => a.candidate.id)).size, 2, 'one recompose after the older landing');
  assert.equal(chain[0].progress.error.code, 'CHANNEL_CHANGED');
  assert.match(chain[0].progress.error.message, /landed, submitted before this one/);
  const receipt = [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === newer.id);
  assert.equal(JSON.parse(receipt.value).orderWaits[0].seconds, PARKED_MS / 1000);
  assert.equal(parkedCount, 0, 'the passed check had not yet recomposed while it was parked');
  for (const [submission, recomposes] of [
    [older, 0],
    [newer, 1],
  ]) {
    const accepted = [...f.tables.projectHostedAcceptances.values()].find(
      row => row.submissionId === submission.id,
    );
    const reply = JSON.parse(
      await f.tx('landingsRead', landings.read, {
        projectId: f.projectId,
        receiptId: accepted.receiptId,
      }),
    );
    const final = queued.get(submission.id);
    assert.equal(final.attemptId, accepted.attemptId, 'the queue read the attempt that landed');
    assert.equal(final.count, recomposes, 'the queue counts distinct Candidates after the first');
    assert.equal(reply.landings[0].recomposeCount, recomposes, 'the receipt agrees');
  }
  const olderChain = attempts(f, older.id);
  assert(
    olderChain.length === 3 && new Set(olderChain.map(attempt => attempt.candidate.id)).size === 1,
    'replay repeats a Candidate binding',
  );
});

test('a failed holder releases a measured order wait shorter than one minute', async t => {
  const { f, older, newer } = await orderWaitJourney(t, 12_500, 'failed');
  assert.equal(stateOf(f, older.id).phase, 'terminal-failed');
  assert.equal(stateOf(f, newer.id).phase, 'landed');
  const receipt = [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === newer.id);
  const waits = JSON.parse(receipt.value).orderWaits;
  assert.equal(waits[0].seconds, 12.5);
  assert.equal(waits[0].at, undefined);
});

test('a ready claim closes the last wait when it finds no holder', async t => {
  const { f, newer } = await orderWaitJourney(t, 6_750, 'claim');
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === newer.id);
  assert.equal(row.orderWait, undefined);
  assert.equal(row.orderWaits[0].at, undefined);
  assert.equal(row.orderWaits[0].seconds, 6.75);
});

test('withdrawing a parked waiter clears the unfinished interval without recording seconds', async t => {
  const { f, newer } = await orderWaitJourney(t, 9_000, 'withdrawn');
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === newer.id);
  assert.equal(stateOf(f, newer.id).error.code, 'LANDING_CANCELLED');
  assert.equal(row.orderWait, undefined);
  assert.equal(row.orderWaits[0].at, undefined);
  assert.equal(row.orderWaits[0].seconds, undefined);
});
