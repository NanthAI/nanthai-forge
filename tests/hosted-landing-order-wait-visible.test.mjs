// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
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
test('replay 19328518: a parked passed landing names the older submission it waits for in every status read', async t => {
  const f = await batchesFixture(t, { count: 2, batching: false, requestCheck: true });
  const [older, newer] = f.entries.map(entry => entry.state);
  assert(older.sequence < newer.sequence);
  let seen = null,
    released = false;
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 400, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    const parked = [...f.tables.projectHostedLandingRequests.values()].find(row => row.orderWait);
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
      seen = { status, landing, page, olderStatus: await f.current(older.id) };
      // The older entry takes as long as the incident's recheck did.
      f.advanceClock(PARKED_MS);
    }
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      // The older check finishes only after the newer one has passed and parked.
      if (runOwner(f, run) === older.id && !seen) continue;
      if (runOwner(f, run) === older.id) released = true;
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const task = f.pending()[0];
    if (!task) break;
    await f.execute(task);
  }
  assert(seen, 'the newer passed entry parked behind the older one');
  assert(released);
  for (const [name, value] of [
    ['finish status', seen.status],
    ['landing status', seen.landing],
    ['observe page', seen.page],
  ]) {
    assert.equal(value.orderWait?.submissionId, older.id, `${name} names the older submission`);
    assert.match(value.orderWait.message, /waiting for older submission .* to take main first/);
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
});
