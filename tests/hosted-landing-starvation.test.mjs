// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const stateOf = (f, id) => states(f).find(s => s.id === id);
const attempts = (f, id) =>
  [...f.tables.projectHostedLandingAttempts.values()]
    .filter(row => row.submissionId === id)
    .map(row => ({ ...JSON.parse(row.value), progress: row.progress ? JSON.parse(row.progress) : null }))
    .sort((a, b) => a.number - b.number);
/** Checks this submission ran itself; a reused cross-head proof is not a check. */
const ownChecks = (f, id) => new Set(attempts(f, id).flatMap(a => (a.check ? [a.check.runId] : []))).size;
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;

/** Incident e4aee4fe (2026-11-01): one slow Candidate checks while fast, newer
 * submissions keep passing and landing. Every slow pass went stale when a newer
 * entry took main, so it re-checked 6+ times in an hour and its builder gave up. */
async function replay(t, { fast = 5 } = {}) {
  // Everyone submits at once, as at B1.5d N=10; the oldest submission is the slow one.
  const f = await batchesFixture(t, { count: fast + 1, batching: false, requestCheck: true });
  const slow = f.entries[0].state;
  const order = [];
  let waitingPolls = 0,
    waited = 0;
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(
      tick < 1500,
      JSON.stringify({ task: f.pending()[0]?.name, phases: states(f).map(s => [s.sequence, s.phase]) }),
    );
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      const owner = runOwner(f, run);
      // The slow check finishes only after every other queued check has passed.
      const othersQueued = f.runs().some(other => other.status === 'queued' && runOwner(f, other) !== owner);
      if (owner === slow.id && othersQueued) continue;
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    // A passed entry waiting for an older one owns no timer: the older one wakes it.
    const parked = [...f.tables.projectHostedLandingRequests.values()].filter(r => r.orderWait);
    // Nor a stall alarm: the older entry it waits for owns progress and its own alarm.
    assert(
      parked.every(r => !r.alarm),
      'a parked waiter holds no stall alarm',
    );
    const waiting = new Set(parked.map(r => r.submissionId));
    waited = Math.max(waited, waiting.size);
    if (stateOf(f, slow.id).phase === 'checking')
      waitingPolls += f
        .pending()
        .filter(
          t => t.name === 'projectHostedFinishDriver:drive' && waiting.has(t.args[0].submissionId),
        ).length;
    const task = f.pending()[0];
    if (!task) break;
    await f.execute(task);
    for (const s of states(f)) if (s.phase === 'landed' && !order.includes(s.id)) order.push(s.id);
  }
  return { f, slow, order, waitingPolls, waited };
}

test('incident replay e4aee4fe: a slow older landing is never overtaken by fast newer ones', async t => {
  const { f, slow, order, waitingPolls, waited } = await replay(t);
  const all = states(f).sort((a, b) => a.sequence - b.sequence);
  t.diagnostic(
    JSON.stringify({
      landingOrder: order.map(id => all.findIndex(s => s.id === id)),
      waitingPolls,
      reasons: all
        .flatMap(s =>
          attempts(f, s.id)
            .filter(a => a.progress?.error?.code === 'CHANNEL_CHANGED')
            .map(a => a.progress.error.message),
        )
        .slice(0, 2),
      checksPerLanding: all.map(s => ownChecks(f, s.id)),
      attemptsPerLanding: all.map(s => attempts(f, s.id).length),
    }),
  );
  assert(
    all.every(s => s.phase === 'landed'),
    JSON.stringify(all.map(s => [s.sequence, s.phase, s.error])),
  );
  assert.deepEqual(
    order,
    all.map(s => s.id),
    'landings take main in submission order',
  );
  assert.equal(ownChecks(f, slow.id), 1, 'the slow Candidate checks once: nothing older was ahead of it');
  for (const [index, s] of all.entries()) {
    assert(
      ownChecks(f, s.id) <= 1 + index,
      `#${s.sequence}: at most one re-check per older entry ahead (${ownChecks(f, s.id)} checks)`,
    );
    // The receipt says why each re-check happened, and it is always an older entry.
    for (const a of attempts(f, s.id).filter(a => a.progress?.error?.code === 'CHANNEL_CHANGED')) {
      assert.match(a.progress.error.message, /landed, submitted before this one/);
      assert.doesNotMatch(a.progress.error.message, /submitted after this one/);
    }
  }
  assert(waited >= 1, 'newer passed entries did wait for the slow one');
  assert.equal(waitingPolls, 0, 'no finish timer polls while an entry waits for an older one');
});

test('B1.5d shape N=10: concurrent arrivals with varied check times land in order with at most one re-check each', async t => {
  const N = 10;
  const f = await batchesFixture(t, { count: N, batching: false, requestCheck: true });
  const ids = f.entries.map(e => e.state.id);
  // The oldest check takes 30 ticks; the others 3-10 (deterministic spread).
  const duration = new Map(ids.map((id, i) => [id, i === 0 ? 30 : 3 + ((i * 5) % 8)]));
  const due = new Map(),
    order = [];
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 3000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      if (!due.has(run.id)) due.set(run.id, tick + duration.get(runOwner(f, run)));
      if (due.get(run.id) <= tick) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    // Running checks report progress, so stall alarms fire only when nothing else is in flight.
    const live = f.pending().filter(task => !task.name.startsWith('projectHostedLandingStall'));
    const checking = f.runs().some(run => run.status === 'queued');
    const task = live[0] ?? (checking ? null : f.pending()[0]);
    if (!task) {
      if (checking) continue;
      break;
    }
    await f.execute(task);
    for (const s of states(f)) if (s.phase === 'landed' && !order.includes(s.id)) order.push(s.id);
  }
  const rechecks = ids.map(id => ownChecks(f, id) - 1);
  t.diagnostic(
    JSON.stringify({
      rechecksPerLanding: rechecks,
      totalChecks: rechecks.length + rechecks.reduce((a, b) => a + b, 0),
    }),
  );
  assert.deepEqual(order, ids, 'submission order');
  assert.equal(rechecks[0], 0, 'the slow oldest entry never re-checks');
  assert(Math.max(...rechecks) <= 1, 'one re-check at most, after the entries ahead landed');
});
