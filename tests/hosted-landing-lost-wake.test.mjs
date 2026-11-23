// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { landingBodyCounts } from './observer-projection-budget.mjs';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { CHECK_WALL_MS } from './queue-sim/invariants.mjs';
const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const stateOf = (f, id) => states(f).find(s => s.id === id);
const requestRow = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;

/** Incident c329d191 (2026-11-05, dev queue stalled ~30 min): a passed head
 * waited in submission order for an older entry. The older entry failed and woke
 * the head's finish exactly once; that drive failed (Convex OCC exhaustion while
 * check progress kept patching train rows). Nothing else re-drove the head, the
 * queue had no lease or wake, and every later passed entry waited on it until an
 * operator resumed it. */
async function replay(t, { loseWake }) {
  const f = await batchesFixture(t, { count: 3, batching: false, requestCheck: true });
  const [older, head, behind] = f.entries.map(entry => entry.state.id);
  let parkedChecked = false,
    headWake = null,
    dropped = false,
    alarmWhenDropped = null;
  for (let tick = 0; ; tick++) {
    assert(tick < 800, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      const owner = runOwner(f, run);
      // Newer checks pass first; the older one fails once a passed entry waits for it.
      if (owner !== older) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      else if (requestRow(f, head)?.orderWait === older) {
        // Parked behind a live older entry: no timer of its own (idle costs nothing).
        const parked = requestRow(f, head);
        assert.equal(parked.alarm ?? null, null, 'a parked waiter holds no stall alarm');
        assert(
          !f
            .pending()
            .some(
              task => task.name.startsWith('projectHostedLandingStall') && task.args[0].submissionId === head,
            ),
          'no stall task for a parked waiter',
        );
        parkedChecked = true;
        await f.fail(run.id, 'tests/member-0.test.mjs');
      }
    }
    const task = f.pending()[0];
    if (!task) break;
    if (
      !headWake &&
      stateOf(f, older).phase === 'terminal-failed' &&
      task.name.startsWith('projectHostedFinishDriver:') &&
      task.args[0].submissionId === head
    ) {
      headWake = { name: task.name, at: Date.now() };
      // The alarm is the backstop for a wake that fails outright (a settle mutation can still throw).
      assert(requestRow(f, head).alarm, 'the wake armed the head stall alarm in the same transaction');
      if (loseWake) {
        // The one wake that ends the wait fails (the incident's OCC exhaustion): nothing of it commits.
        f.patch('_scheduled_functions', task._id, {
          state: { kind: 'failed', error: 'synthetic OCC exhaustion (incident c329d191)' },
        });
        dropped = true;
        alarmWhenDropped = requestRow(f, head).alarm;
        continue;
      }
    }
    await f.execute(task);
    if (states(f).every(s => s.phase === 'landed' || s.phase === 'terminal-failed')) break;
  }
  assert(parkedChecked, 'the replay parked the passed head behind the older entry');
  f.headWake = headWake;
  if (loseWake) {
    assert(dropped, 'the replay reached the lost wake');
    assert(alarmWhenDropped, 'the lost wake left the head stall alarm armed');
  }
  assert.equal(stateOf(f, older).phase, 'terminal-failed');
  assert.equal(stateOf(f, head).phase, 'landed', loseWake ? 'the stall alarm re-drives the passed head' : '');
  assert.equal(stateOf(f, behind).phase, 'landed', 'entries waiting behind the head drain after it');
  for (const id of [head, behind])
    assert.equal(requestRow(f, id).alarm ?? null, null, 'landing clears the alarm');
  return f;
}

// The waiter's one wake has no IO in flight, so it is the settle mutation (Item 9a04d916), which
// Convex runs exactly once; it can still fail outright, as the incident's step did. Then the
// stall alarm, armed in the same transaction, is the backstop that re-drives the head.
test('incident replay c329d191: a lost finish wake after an order wait never strands a passed head', async t => {
  const f = await replay(t, { loseWake: true });
  assert.equal(
    f.headWake?.name,
    'projectHostedFinishDriver:settle',
    'the lost waiter wake is the settle mutation',
  );
});

// Review d4f55e9f F3 (Item 9a04d916): delivered, that settle lands the head within one check
// wall and its 15-minute alarm never fires.
test('incident c329d191: with the wake delivered the head lands at once and its alarm never fires', async t => {
  const f = await replay(t, { loseWake: false });
  assert.equal(
    f.headWake?.name,
    'projectHostedFinishDriver:settle',
    'the waiter wake is the settle mutation',
  );
  // test-signal: allow Date.now is the fixture's injected scheduler clock
  assert(Date.now() - f.headWake.at < CHECK_WALL_MS, 'the head landed within one check wall of its wake');
  assert(!states(f).some(s => s.observation?.stall), 'no entry was marked stalled');
});

test('incident c329d191 class: a holder that lost its completion wake and its alarm is re-driven by a parked reader', async t => {
  // The older entry's check failed while the passed head waited in order for it.
  // Its completion wake and every supervisor task were lost (two faults, e.g. OCC
  // exhaustion then an outage), so nothing owns the older entry and the head is
  // parked behind it. Only the head's reader is waiting; it asks about itself.
  const f = await batchesFixture(t, { count: 3, batching: false, requestCheck: true });
  const [older, head, behind] = f.entries.map(entry => entry.state.id);
  let olderRun = null,
    asked = null;
  const costs = {};
  const lostTask = task =>
    olderRun && !asked && (task.args[0]?.submissionId === older || task.args[0]?.runId === olderRun);
  for (let tick = 0; ; tick++) {
    assert(tick < 800, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      if (runOwner(f, run) !== older) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      else if (requestRow(f, head)?.orderWait === older) {
        // Healthy holder first: the same ask finds nothing lost and writes nothing.
        const reply = JSON.parse(
          await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: head }),
        );
        assert.deepEqual(reply, { redriven: [] });
        costs.healthy = f.counts.at(-1);
        olderRun = run.id;
        await f.fail(run.id, 'tests/member-0.test.mjs');
      }
    }
    const task = f.pending()[0];
    if (!task && olderRun && !asked) {
      // Stranded: nothing is scheduled while every entry is still live.
      assert.equal(stateOf(f, older).phase, 'checking', 'the older entry never learned its run failed');
      assert.equal(requestRow(f, head).orderWait, older, 'the passed head waits for it');
      // Its reader's quiet-period ask (src/hosted-landing-redrive.ts) follows the order wait.
      f.advanceClock(2 * 60_000);
      asked = JSON.parse(
        await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: head }),
      );
      costs.stranded = f.counts.at(-1);
      continue;
    }
    if (!task) break;
    if (lostTask(task)) {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      continue;
    }
    await f.execute(task);
    if (states(f).every(s => s.phase === 'landed' || s.phase === 'terminal-failed')) break;
  }
  assert(asked, 'the replay stranded the queue and the reader asked');
  assert.deepEqual(asked.redriven, [], 'the parked head itself lost nothing');
  assert.deepEqual(
    asked.holders.map(h => h.submissionId),
    [older],
    'the ask re-drove the holder of its order wait',
  );
  assert(asked.holders[0].redriven.includes('check'), JSON.stringify(asked));
  assert.equal(stateOf(f, older).phase, 'terminal-failed');
  assert.equal(stateOf(f, head).phase, 'landed');
  assert.equal(stateOf(f, behind).phase, 'landed');
  assert.equal(f.tables.projectHostedAcceptances.size, 2, 'each landing accepted once');
  // Ask-only cost: one hop adds a few indexed reads; a healthy holder writes nothing.
  const cost = ({ name, documents, ranges, writes }) => ({ name, documents, ranges, writes });
  t.diagnostic(JSON.stringify({ healthy: cost(costs.healthy), stranded: cost(costs.stranded) }));
  assert.equal(costs.healthy.name, 'redrive');
  assert.equal(costs.healthy.writes, 0, 'a healthy holder: no writes');
  assert(
    costs.healthy.documents - landingBodyCounts(costs.healthy).reads <= 9,
    `healthy ask read ${costs.healthy.documents} documents`,
  );
  assert(
    costs.stranded.documents - landingBodyCounts(costs.stranded).reads <= 10,
    `stranded ask read ${costs.stranded.documents} documents`,
  );
  // A repeated ask replays nothing new.
  const again = JSON.parse(
    await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: behind }),
  );
  assert.deepEqual(again, { redriven: [] });
});
