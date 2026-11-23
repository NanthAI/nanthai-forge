// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Cohort hold (Issue 10b0a94b; model `prequeue-cohort`, litmus `cohorthold`):
// admitted changes that miss proved reuse on a moved main form one cohort.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_TRAIN_HOLD_MS } from '../dist/hosted-landing-batch.js';
const landings = await import(moduleUrl('../convex/projectHostedLandings.ts'));
const admission = await import(moduleUrl('../convex/projectHostedLandingAdmission.ts'));
const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-cohort-hold',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const row = (f, id) => rows(f).find(r => r.submissionId === id);
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(r => JSON.parse(r.value));
const isLane = (f, run) =>
  f.entries.some(e =>
    [0, 1, 2].some(n => admission.admissionOperationId(e.state.id, n) === run.request.operationId),
  );
const queueRuns = f => f.runs().filter(run => !isLane(f, run));
const mark = (f, task, kind) => f.patch('_scheduled_functions', task._id, { state: { kind } });

/** Three changes pass their Lane checks together. The first lands on its own run
 * and moves main; the other two are refused and recompose. `hook(task)` may drop
 * a task (returns a state kind) to replay a lost step. Every run passes. */
/** The last change's finish runs late: each of its drives due after main moved,
 * before the second change held, runs one second later. Without the delay it
 * would be refused beside the second (early refusal, 7fe54c7c) and no hold would
 * be needed; with it, the second holds while the last is still deciding. */
const lateLastChange = () => {
  const delayed = new Set();
  return (task, f, ids) => {
    if (
      task.name !== 'projectHostedFinishDriver:drive' ||
      task.args[0].submissionId !== ids[2] ||
      states(f)[0].phase !== 'landed' ||
      row(f, ids[1])?.admission?.hold ||
      delayed.has(task._id)
    )
      return null;
    delayed.add(task._id);
    f.patch('_scheduled_functions', task._id, { scheduledTime: Date.now() + 1000 });
    return 'pending';
  };
};
async function wave(t, hook = () => null, stop = () => false) {
  const count = 3;
  const f = await batchesFixture(t, {
    count,
    batchMaxSize: null,
    admissionCheck: 'full',
  });
  const ids = f.entries.map(e => e.state.id);
  const events = [];
  for (let tick = 0; ; tick++) {
    assert(tick < 600, JSON.stringify(states(f).map(s => s.phase)));
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (!task) break;
    const kind = hook(task, f, ids);
    if (kind) {
      events.push({ dropped: task.name, at: Date.now() });
      mark(f, task, kind);
      if (stop(task)) break;
      continue;
    }
    await f.execute(task);
    for (const id of ids) {
      const hold = row(f, id)?.admission?.hold;
      if (hold && !events.some(e => e.held === id)) events.push({ held: id, since: hold.since });
      if (hold?.done && !events.some(e => e.released === id)) {
        assert.equal(hold.endedAt, f.now(), 'the original release stamps its transaction time');
        events.push({ released: id, by: task.name, at: Date.now() });
      }
    }
  }
  return { f, ids, events };
}

test('a refused change holds for a peer still deciding and they form one cohort', async t => {
  const { f, ids, events } = await wave(t, lateLastChange());
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(queueRuns(f).length, 1, 'one combined check, not one per refused change');
  const [cohort] = batches(f);
  assert.deepEqual(new Set(cohort.members.map(m => m.submissionId)), new Set(ids.slice(1)));
  assert.equal(events.filter(e => e.held).length, 1, 'only the earlier refused change held');
  const query = async args =>
    JSON.parse(
      await f.tx('cohort-hold-evidence', landings.read, {
        projectId: f.projectId,
        ...args,
      }),
    );
  const start = events.find(e => e.held).since;
  const end = events.find(e => e.released).at;
  const receipt = [...f.tables.projectHostedAcceptances.values()].find(r => r.submissionId === ids[1]);
  const exact = {
    status: 'released',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    seconds: (end - start) / 1000,
  };
  assert.deepEqual((await query({ receiptId: receipt.receiptId })).landings[0].cohortHold, exact);
  assert.deepEqual((await query({ submissionId: ids[1] })).cohortHold, exact);
  assert.equal((await query({ submissionId: ids[0] })).cohortHold, null);
  const held = row(f, ids[1]);
  const { endedAt: _newStamp, ...legacy } = held.admission.hold;
  f.patch('projectHostedLandingRequests', held._id, { admission: { ...held.admission, hold: legacy } });
  assert.deepEqual((await query({ submissionId: ids[1] })).cohortHold, {
    status: 'unavailable',
    startedAt: exact.startedAt,
    endedAt: null,
    seconds: null,
  });
  assert.equal(f.pending().length, 0, 'idle after settling: no timers or polling');
});

test('admitted changes that miss proved reuse wait for each other and form one cohort', async t => {
  const { f, ids, events } = await wave(t);
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(queueRuns(f).length, 1, 'one combined check, not one per refused change');
  const [cohort] = batches(f);
  assert.deepEqual(new Set(cohort.members.map(m => m.submissionId)), new Set(ids.slice(1)));
  // Both stale Lane proofs are refused in one pass (early refusal), so they
  // recompose together and neither needs to hold for the other.
  assert.equal(events.filter(e => e.held).length, 0, 'refused together: no hold');
  assert(
    rows(f).every(r => r.deciding === undefined),
    'no decision left open',
  );
  assert.equal(f.pending().length, 0, 'idle after settling: no timers or polling');
});

test('one shared replacement retains a donor refusal from its evaluated members', async t => {
  const { f } = await wave(t, (_, fixture) => {
    const cohort = batches(fixture).find(entry => entry.phase === 'composing');
    for (const [index, member] of (cohort?.members ?? []).entries()) {
      const selected = row(fixture, member.submissionId);
      const usable = index !== 0;
      if (selected.admission?.auditDonor?.usable !== usable)
        fixture.patch('projectHostedLandingRequests', selected._id, {
          admission: { ...selected.admission, auditDonor: { attemptId: member.id, usable } },
        });
    }
    return null;
  });
  const [replacement] = queueRuns(f);
  assert.equal(queueRuns(f).length, 1);
  const stored = [...f.tables.projectHostedCheckRuns.values()].find(run => run.runId === replacement.id);
  assert.equal(stored.auditDonor, false);
});

test('a lost release wake is re-driven by the hold’s own wake at its bound (c329d191 class)', async t => {
  let lost = false;
  const late = lateLastChange();
  const { f, events } = await wave(t, (task, f, ids) => {
    // The peer's decision released the hold and scheduled one queue drive; that
    // drive fails (OCC exhaustion) and nothing of it commits.
    const released = row(f, ids[1])?.admission?.hold?.done;
    if (!lost && released && task.name === 'projectHostedLandingDriver:drive') {
      lost = true;
      return 'failed';
    }
    return late(task, f, ids);
  });
  assert(lost, 'the release wake was dropped');
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(queueRuns(f).length, 1);
  const since = events.find(e => e.held).since;
  const formed = Date.parse(batches(f)[0].at);
  assert(formed - since <= HOSTED_TRAIN_HOLD_MS, 'formed by the bound, before any 15-minute stall alarm');
});

test('a peer that never decides holds a refused change for the bound only', async t => {
  const { f, ids, events } = await wave(t, (task, f, ids) =>
    // The last peer's publication attempt never runs once main moved (a stuck
    // step, cancelled).
    task.name === 'projectHostedFinishDriver:drive' &&
    task.args[0].submissionId === ids[2] &&
    states(f)[0].phase === 'landed'
      ? 'canceled'
      : null,
  );
  const held = events.find(e => e.held);
  const released = events.find(e => e.released);
  assert.equal(held?.held, ids[1]);
  assert.equal(released.by, 'projectHostedLandingCohortHold:end', 'its own wake ended the hold');
  assert.equal(released.at - held.since, HOSTED_TRAIN_HOLD_MS, 'exactly at the bound');
  assert.equal(states(f)[1].phase, 'landed', 'the held change landed on its own check');
  assert.equal(queueRuns(f).length, 1);
});

test('a hold wake refused by a write outage is re-driven when writes resume (72d50375 class)', async t => {
  let thrown = null;
  const { f, ids } = await wave(
    t,
    (task, f, ids) => {
      if (
        task.name === 'projectHostedFinishDriver:drive' &&
        task.args[0].submissionId === ids[2] &&
        states(f)[0].phase === 'landed'
      )
        return 'canceled';
      if (!thrown && task.name === 'projectHostedLandingCohortHold:end') {
        thrown = task;
        return 'failed';
      }
      return null;
    },
    task => task === thrown,
  );
  assert(thrown, 'the hold wake threw');
  const before = row(f, ids[1]);
  assert(before.phase === 'queued' && !before.runnable && !before.admission.hold.done, 'still held');
  const done = await f.transaction(
    'redrive',
    { _handler: ctx => redrive.redriveLanding(ctx, row(f, ids[1])) },
    {},
  );
  assert(done.includes('hold'));
  for (let tick = 0; f.pending().length; tick++) {
    assert(tick < 300);
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.execute(f.pending()[0]);
  }
  assert.equal(states(f)[1].phase, 'landed');
  assert(row(f, ids[1]).admission.hold.done);
});
