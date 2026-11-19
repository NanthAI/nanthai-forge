// SPDX-License-Identifier: Apache-2.0
// Incident 5e3c3a3c, rule N1: the new-run wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { parkedIncident } from './queue-sim/parked-incident.mjs';
const { bindsNewRun } = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const { HOSTED_ORDER_WAITS } = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-queue-sim' };
const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const holder = {
  phase: 'queued',
  priority: 'normal',
  attemptId: 'a2',
  runId: 'r2',
  orderWaited: true,
};
test('new-run wake fires only when an order holder starts checking a run it can be charged for', () => {
  const queued = { phase: 'queued' },
    checking = { phase: 'checking' },
    ready = { phase: 'ready' };
  const next = { phase: 'checking', attemptId: 'a2' };
  assert(bindsNewRun(holder, queued, next, 'r2', true), 'starts checking its bound re-check run');
  assert(bindsNewRun({ ...holder, phase: 'checking' }, checking, next, 'r3', true), 'binds a new run');
  // c6953f0b: a queued entry is a free overtake and records no lifetime mark.
  const bind = { phase: 'queued', attemptId: 'a2' };
  assert(!bindsNewRun({ ...holder, runId: 'r1' }, ready, bind, 'r2', true), 'binding while queued');
  assert(!bindsNewRun({ ...holder, runId: 'r1' }, ready, bind, 'r1', true), 'a carry re-pin');
  assert(!bindsNewRun({ ...holder, phase: 'checking' }, checking, next, 'r2', true), 'bookkeeping write');
  assert(!bindsNewRun(holder, queued, next, null, true), 'no run');
  assert(!bindsNewRun(holder, queued, next, 'r2', false), 'leaving order uses the existing exit wake');
  assert(!bindsNewRun({ ...holder, orderWaited: undefined }, queued, next, 'r2', true), 'no followers');
  assert(!bindsNewRun({ ...holder, overtaken: 'a0:r0' }, queued, next, 'r2', true), 'lifetime bound');
  assert(!bindsNewRun({ ...holder, overtaken: 'a2:r2' }, queued, next, 'r2', true), 'already charged');
  assert(!bindsNewRun({ ...holder, priority: 'urgent' }, queued, next, 'r2', true), 'urgent keeps order');
});

// The incident shape: H checking; A (overlaps H) passed and parked on H; four disjoint
// passed followers parked on A ('accepting'). H passes and lands; A must re-check.
async function settleIncident(t) {
  const { f, followers, holder: a } = await parkedIncident(t);
  const passedRuns = Object.fromEntries(
    followers.map(id => [
      id,
      [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id).runId,
    ]),
  );
  // From here A's re-check run is bound. Checks take 10 simulated minutes.
  const RUN_MS = 600_000;
  const start = Date.now(),
    calls = f.counts.length,
    proofs = f.reuseDecisions.length,
    runs = f.runs().length;
  const started = new Map();
  for (let step = 0; step < 4000; step++) {
    const due = f.pending().find(task => task.scheduledTime <= Date.now());
    if (due) {
      await f.execute(due);
      continue;
    }
    const queued = f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit');
    for (const run of queued) if (!started.has(run.id)) started.set(run.id, Date.now());
    const runAt = Math.min(...queued.map(run => started.get(run.id) + RUN_MS));
    const timerAt = f.pending()[0]?.scheduledTime ?? Infinity;
    if (runAt === Infinity && timerAt === Infinity) break;
    f.advanceClock(Math.max(0, Math.min(runAt, timerAt) - Date.now()));
    if (runAt <= timerAt)
      for (const run of queued.filter(r => started.get(r.id) + RUN_MS <= Date.now()))
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  }
  const receipts = new Map(
    [...f.tables.projectHostedAcceptances.values()].map(r => {
      const value = JSON.parse(r.value);
      return [value.submissionId, value];
    }),
  );
  const minutes = id => (Date.parse(receipts.get(id).acceptedAt ?? receipts.get(id).at) - start) / 60_000;
  return {
    followers: followers.map(minutes),
    holder: minutes(a),
    ownPass: followers.every(id => receipts.get(id).check?.runId === passedRuns[id]),
    newRuns: f.runs().length - runs,
    proofs: f.reuseDecisions.length - proofs,
    calls: f.counts.length - calls,
    unsettled: [...f.tables.projectHostedLandingRequests.values()].filter(
      r => !['landed', 'terminal-failed'].includes(r.phase),
    ).length,
    idle: f.pending().length,
  };
}
// The same replay before N1 (measured on the last code with the wake off, Item 48697ee7): every
// follower waited out the head's 10-minute re-check, the head landed at 10 minutes, 4 proofs and
// 110 Convex calls. The wake's bounds are stated against those numbers.
const BEFORE_N1 = { holder: 10, proofs: 4, calls: 110 };
test('5e3c3a3c new-run wake: disjoint passed followers take main while the head re-checks', async t => {
  const run = await settleIncident(t);
  t.diagnostic(JSON.stringify({ before: BEFORE_N1, run }));
  assert(run.ownPass, 'every follower lands on its own passed run');
  assert.equal(run.newRuns, 0, 'no follower or holder check is added');
  assert.equal(run.unsettled, 0);
  assert.equal(run.idle, 0, 'idle after settling: no timers or polling');
  assert(Math.max(...run.followers) <= 0.1, `followers within 0.1 min: ${run.followers}`);
  assert(run.holder <= BEFORE_N1.holder + 0.1, 'the overtaken head is not delayed');
  // The head checked while main moved: it carries its pass with one proof (7d98c7da price).
  assert(run.proofs <= BEFORE_N1.proofs + 1, `proofs ${BEFORE_N1.proofs} -> ${run.proofs}`);
  assert(run.calls <= BEFORE_N1.calls * 1.25, `calls ${BEFORE_N1.calls} -> ${run.calls}`);
});

const requests = f => [...f.tables.projectHostedLandingRequests.values()];
const request = (f, id) => requests(f).find(r => r.submissionId === id);
const drives = f =>
  [...f.tables._scheduled_functions.values()].filter(task => task.name === 'projectHostedFinishDriver:drive');

// Review c6953f0b finding 1: followers that overtake a holder in successive generations must
// each count toward its one lifetime re-check. Exact re-checks (no cross-head proof), so any
// follower landing ahead of A makes A's run stale. Followers' finish drives run first.
test('5e3c3a3c new-run wake: overtakes in successive generations re-check the holder once', async t => {
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    batching: false,
    requestCheck: true,
    memberPaths: ['src/shared.ts', 'src/shared.ts', 'src/independent-0.ts', 'src/independent-1.ts'],
    baselineFiles: [['src/shared.ts', 'export const a = 0;\n// gap\nexport const b = 0;\n']],
    memberContents: [
      'export const a = 1;\n// gap\nexport const b = 0;\n',
      'export const a = 0;\n// gap\nexport const b = 1;\n',
    ],
  });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, hostedCrossHeadReuse: false } },
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const owner = run =>
    [...f.tables.projectHostedLandingAttempts.values()].find(r => JSON.parse(r.value).check?.runId === run.id)
      ?.submissionId;
  const h = (await f.add(0)).id,
    a = (await f.add(1)).id;
  const holderRuns = new Set();
  const passRuns = async (hold = false) => {
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit')) {
      if (owner(run) === a) holderRuns.add(run.id);
      if (hold && owner(run) === a) continue;
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
  };
  const work = () => f.pending().filter(task => !/MainAudit:start|LandingStall/.test(task.name));
  const due = () => work().filter(task => task.scheduledTime <= Date.now());
  const phase = id => request(f, id)?.phase;
  const ownDrive = (task, id) =>
    task.name === 'projectHostedFinishDriver:drive' && task.args[0]?.submissionId === id;
  // H lands; A passed on the old main and is still Ready (its own drive deferred).
  for (let i = 0; i < 400 && phase(h) !== 'landed'; i++) {
    await passRuns();
    const task = work().find(task => !(phase(a) === 'ready' && ownDrive(task, a)));
    if (!task) break;
    await f.execute(task);
  }
  assert.equal(phase(h), 'landed');
  const followers = [];
  for (const i of [2, 3]) {
    // A fresh disjoint follower on the current main passes and parks on Ready A ('accepting').
    const b = (await f.add(i)).id;
    followers.push(b);
    for (let step = 0; step < 400 && request(f, b)?.orderWait !== a && phase(b) !== 'landed'; step++) {
      await passRuns(true);
      const task = work().find(task => task.args[0]?.submissionId !== a);
      if (!task) break;
      await f.execute(task);
    }
    assert.equal(request(f, b).orderWait, a, 'the follower parks on the Ready holder');
    // A re-checks (main moved). Permitted order: follower finish drives before the dispatcher.
    for (let step = 0; step < 400 && phase(b) !== 'landed'; step++) {
      await passRuns(true);
      const parked = task => followers.some(id => ownDrive(task, id));
      const task = due().find(parked) ?? work().find(task => !parked(task));
      if (!task || (phase(a) === 'checking' && !due().some(parked))) break;
      await f.execute(task);
    }
    if (i === 2) {
      assert.equal(phase(b), 'landed', 'the first follower takes main during the holder re-check');
      assert(request(f, a).overtaken, 'and that overtake is charged to the holder generation');
    } else assert.equal(request(f, b).orderWait, a, 'the second follower waits: the bound is spent');
    // A passes this run; a stale pass re-checks, and A ends Ready (or landed).
    for (let step = 0; step < 400 && !(phase(a) === 'ready' && !request(f, a).orderWait); step++) {
      if (phase(a) === 'landed') break;
      await passRuns();
      const task = work().find(task => !(phase(a) === 'ready' && ownDrive(task, a)));
      if (!task) break;
      await f.execute(task);
    }
  }
  for (let step = 0; step < 2000; step++) {
    await passRuns();
    const task = work()[0];
    if (!task) break;
    await f.execute(task);
  }
  assert.deepEqual([h, a, ...followers].map(phase), ['landed', 'landed', 'landed', 'landed']);
  // Its first run, the re-check H forced, and at most one more for the overtake.
  assert(holderRuns.size <= 3, `holder runs ${holderRuns.size}`);
});

// Review c6953f0b finding 2: the follower's evidence must name this holder. The oldest follower's
// latest receipt names a former holder; the next one's receipt list is full (stops recording).
test('5e3c3a3c new-run wake: only followers whose latest wait names this holder are woken', async t => {
  const {
    f,
    followers,
    holder: a,
  } = await parkedIncident(t, {
    seed(f, { head, holder, followers: [stale, saturated] }) {
      const wait = submissionId => ({ submissionId, held: 'accepting', footprints: 'disjoint' });
      f.patch('projectHostedLandingRequests', request(f, stale)._id, { orderWaits: [wait(head)] });
      f.patch('projectHostedLandingRequests', request(f, saturated)._id, {
        orderWaits: Array.from({ length: HOSTED_ORDER_WAITS }, (_, i) =>
          wait(i === HOSTED_ORDER_WAITS - 1 ? holder : head),
        ),
      });
    },
  });
  const [stale, saturated, eligible, younger] = followers.map(id => request(f, id));
  assert.equal(stale.orderWait, a, 'stale evidence: stays parked on the holder');
  assert(!stale.alarm);
  assert.equal(saturated.orderWait, a, 'saturated history: stays parked on the holder');
  assert.equal(eligible.orderWait, undefined, 'the oldest follower with current evidence is driven');
  assert(eligible.alarm, 'with its stall alarm armed');
  assert.equal(younger.orderWait, eligible.submissionId, 'the next one waits on it');
});

// Review c6953f0b finding 3: one bind, one drive. The oldest eligible follower no longer holds
// its place (Ready, parked, no orderLive): it cannot release younger ones, so they stay on the
// holder, which can.
test('5e3c3a3c new-run wake: a bound run drives exactly one follower', async t => {
  let known;
  const {
    f,
    followers,
    holder: a,
  } = await parkedIncident(t, {
    seed(f, { followers: [oldest] }) {
      f.patch('projectHostedLandingRequests', request(f, oldest)._id, { orderLive: undefined });
      known = new Set(drives(f).map(task => task._id));
    },
  });
  const driven = new Set(
    drives(f)
      .filter(task => !known.has(task._id) && followers.includes(task.args[0]?.submissionId))
      .map(task => task.args[0].submissionId),
  );
  assert.deepEqual([...driven], [followers[0]], 'one follower drive for the bind');
  for (const id of followers.slice(1))
    assert.equal(request(f, id).orderWait, a, 'the rest stay on the holder');
});
