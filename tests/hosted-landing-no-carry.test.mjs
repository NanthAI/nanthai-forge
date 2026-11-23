// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 1018d0f8 (decision c2be3da5), incident 0e94a117: a plain change does not start its Lane check
// while a spent order-sensitive holder at the head of the order is checking; the holder's exit (land,
// fail, withdraw) starts it through the real wake path. Bars from Fable's measured plan (comment
// 799c660f): today the 6-arrival replay loses 1,088 runner ticks, slowest landing 1,288, 554 calls.
// The call and mean bars are one above Fable's (587 / 555 / 316): the release is one scheduled call
// per holder exit (review a26ba245 P1-1, P2-4), accepted by the lead in comment 3804291b.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { drive } from './queue-sim/overtake-drive.mjs';
const { noCarryHold } = await import(moduleUrl('../src/landing-overtake.ts'));
const { NO_CARRY_HOLD_SETTING, noCarryHoldOn } = await import(
  moduleUrl('../convex/projectHostedLandingNoCarry.ts')
);
const { landingOrderWaitForReader } = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
const priority = await import(moduleUrl('../convex/projectHostedLandingPriority.ts'));
const stall = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const { LANDING_STALL_MS } = await import(moduleUrl('../src/landing-stall.ts'));
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-overtake',
  FORGE_QUEUE_NO_CARRY_HOLD: '1',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const D = 150;
const spend = index => (f, ids) => {
  for (const row of f.tables.projectHostedLandingRequests.values())
    if (row.submissionId === ids[index])
      f.patch('projectHostedLandingRequests', row._id, { overtaken: 'earlier:generation' });
};
const late = (k, spent = true) => ({
  memberPaths: [
    'src/first.ts',
    'convex/schema.ts',
    'src/p1.ts',
    ...Array.from({ length: k }, (_, i) => `src/q${i}.ts`),
  ],
  fixture: { landingMode: 'fast' },
  ...(spent ? { prepare: spend(1) } : {}),
  arrives: i => (i < 3 ? 0 : 300),
  duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 1000) : D),
});
const run = (t, shape) => drive(t, { ownerApprovalPaths: ['scripts/deploy*'], ...shape });
const lost = r => r.runTicks.filter(x => !x.used).reduce((a, b) => a + b.ticks, 0);
const noCarryWaits = r => r.orderWaits.map(waits => waits.filter(w => w.held === 'no-carry'));

test('incident 1018d0f8 replay: six late plain arrivals start their checks only after the spent schema holder lands', async t => {
  const shape = late(6);
  const r = await run(t, shape);
  const holderLanded = r.landedAt[1];
  const lateRuns = r.runTicks.filter(x => x.owner >= 3);
  assert.equal(lateRuns.length, 6, 'one check per late arrival: none thrown away');
  for (const x of lateRuns) assert(x.started >= holderLanded, JSON.stringify({ x, holderLanded }));
  // Each held change's receipt records which submission it waited for and why.
  for (const waits of noCarryWaits(r).slice(3))
    assert.deepEqual(
      waits.map(w => w.submissionId),
      [r.ids[1]],
    );
  const lat = r.landedAt.map((v, i) => v - shape.arrives(i));
  assert(lost(r) <= 206, `lost runner ticks ${lost(r)} (today 1,088)`);
  assert(Math.max(...lat) <= 1288 + 16, `slowest landing ${Math.max(...lat)} (today 1,288)`);
  assert(r.calls <= 587, `calls ${r.calls}`);
  assert.equal(r.idle, 0);
});

test('incident 1018d0f8: a withdrawn holder starts every held check at once, each lands within one check of the exit', async t => {
  const r = await run(t, {
    memberPaths: [
      'src/first.ts',
      'convex/schema.ts',
      ...[0, 1, 2].map(i => `src/q${i}.ts`),
      '.github/actions/w9/action.yml',
    ],
    fixture: { landingMode: 'fast' },
    prepare: spend(1),
    arrives: i => (i < 2 ? 0 : 100),
    withdraws: (i, nth) => i === 1 && nth === 2,
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 600) : D),
  });
  const exit = r.withdrawnAt[1];
  assert(exit !== undefined);
  const held = noCarryWaits(r)
    .map((waits, i) => (waits.length ? i : -1))
    .filter(i => i >= 0);
  assert.deepEqual(held, [2, 3, 4], 'the plain arrivals were held; the CI change with its own risk was not');
  // Today they land on the check they ran behind the holder; held, each runs one check from the
  // exit. The CI change lands in the same tick and moves main, so the release recomposes each held
  // change on the new main first (about 20 ticks, the scheduled release one of them); no check
  // runs a check's length and is thrown away.
  const recompose = 25;
  for (const i of held) {
    const runs = r.runTicks.filter(x => x.owner === i);
    assert(
      runs.every(x => x.started >= exit && x.started <= exit + recompose),
      JSON.stringify({ i, exit, runs }),
    );
    assert.equal(runs.filter(x => x.used).length, 1);
    assert(
      runs.filter(x => !x.used).every(x => x.ticks < 10),
      JSON.stringify(runs),
    );
    // Review a26ba245 7: each waiter lands within one check of the exit (plus the recompose before
    // it and the land step after it, 20 ticks; measured 184 to 220 for the three).
    assert(
      r.landedAt[i] - exit <= recompose + D + 20 + 30 * held.indexOf(i),
      JSON.stringify({ i, exit, landed: r.landedAt[i] }),
    );
  }
  const lat = r.landedAt.filter(v => v !== undefined).map((v, i) => v - (i < 1 ? 0 : 100));
  const mean = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  // Fable's measured arm (comment 799c660f): mean 498 to 554 (one check time), lost 783 to 644, calls
  // 364 to 315; one tick and one call above it for the scheduled release (comment 3804291b).
  assert(mean <= 555, `mean landing ${mean}`);
  assert(lost(r) <= 644, `lost runner ticks ${lost(r)}`);
  assert(r.calls <= 316, `calls ${r.calls}`);
  assert.equal(r.idle, 0);
});

test('incident 1018d0f8: never held behind an unspent step, a change with its own risk, or an older entry ahead', async t => {
  // 43b51a5e shape: the step is not spent, so the late arrivals may still overtake once.
  const unspent = late(6, false);
  const a = await run(t, unspent);
  assert(noCarryWaits(a).every(w => !w.length));
  const plain = a.landedAt.map((v, i) => v - unspent.arrives(i)).filter((_, i) => i !== 1);
  assert.equal(Math.round(plain.reduce((x, y) => x + y, 0) / plain.length), 194, 'plain mean landing kept');
  // e66c904c shape: newer CI-action changes carry their own order-sensitive risk.
  const b = await run(t, {
    memberPaths: [
      'src/first.ts',
      'convex/schema.ts',
      ...[0, 1, 2].map(i => `.github/actions/w${i}/action.yml`),
    ],
    fixture: { landingMode: 'fast' },
    prepare: spend(1),
    arrives: i => (i < 2 ? 0 : 100),
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 400) : D),
  });
  assert(noCarryWaits(b).every(w => !w.length));
  // Head of order: an older plain entry still in its Lane check ahead of the spent holder can land
  // first, so the newer plain changes are not held behind the holder.
  // Review a26ba245 7: the first change lands at once and moves main, so the spent schema holder
  // re-checks in order while the older O restarts its Lane check on the new main; the followers
  // arrive then, and both preconditions are asserted at their arrival.
  let seen;
  const c = await run(t, {
    memberPaths: ['src/first.ts', 'src/o.ts', 'convex/schema.ts', 'src/y0.ts', 'src/y1.ts'],
    fixture: { landingMode: 'fast' },
    prepare: spend(2),
    arrives: i => (i < 3 ? 0 : 100),
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? 3 * D : i === 2 ? (nth === 1 ? 30 : 1000) : D),
    afterStep: f => {
      const rows = [...f.tables.projectHostedLandingRequests.values()].sort(
        (a, b) => a.sequence - b.sequence,
      );
      if (seen || rows.length < 4) return;
      seen = { older: rows[1], holder: rows[2] };
    },
  });
  assert(seen, 'the followers arrived');
  assert.equal(seen.older.admitting, true, 'the older entry is still in its Lane check');
  assert.equal(seen.holder.phase, 'checking');
  assert.equal(seen.holder.orderLive, true, 'the spent holder checks in order');
  assert.notEqual(seen.holder.overtaken, undefined);
  assert(noCarryWaits(c).every(w => !w.length));
});

test('incident 1018d0f8: making a held change urgent starts its Lane check at once', async t => {
  let urgentAt;
  const r = await run(t, {
    ...late(1),
    afterStep: async (f, tick) => {
      if (urgentAt !== undefined) return;
      const row = [...f.tables.projectHostedLandingRequests.values()].find(row => row.noCarryWait);
      if (!row) return;
      const reply = JSON.parse(
        await f.transaction(
          'priorityChange',
          priority.prioritize,
          {
            projectId: f.projectId,
            submissionId: row.submissionId,
            operationId: randomUUID(),
            priority: 'urgent',
            authorityEpoch: 1,
            expectedVersion: row.priorityVersion ?? 0,
          },
          'owner',
        ),
      );
      assert.equal(reply.priority, 'urgent', JSON.stringify(reply));
      urgentAt = tick;
    },
  });
  assert(urgentAt !== undefined, 'the late arrival was held');
  const [first] = r.runTicks.filter(x => x.owner === 3);
  assert(first.started <= urgentAt + 1 && first.started < r.landedAt[1], JSON.stringify({ first, urgentAt }));
  assert.equal(r.idle, 0);
});

test('incident 1018d0f8: a held change keeps its stall alarm quiet while the holder checks; a lost release is released by the alarm', async t => {
  // Review a26ba245 1: the holder's exit only schedules the release; if that release is lost, the
  // held change's stall alarm (re-armed at the exit) releases it as the exit would. The drive's
  // fixture clock is 2026-11-10 12:00 UTC; the alarm fires two stall windows later.
  const later = Date.UTC(2026, 10, 10, 12) + 2 * LANDING_STALL_MS;
  const fire = (f, row) =>
    f.transaction(
      'heldAlarm',
      { _handler: (ctx, input) => stall.raiseLandingAlarm(ctx, input, later) },
      { projectId: f.projectId, submissionId: row.submissionId, lastProgressAt: row.alarm.lastProgressAt },
    );
  const held = f => [...f.tables.projectHostedLandingRequests.values()].find(row => row.noCarryWait);
  let quiet, lostRelease, fallback;
  const r = await run(t, {
    ...late(1),
    afterStep: async (f, tick, task) => {
      const row = held(f);
      if (!quiet && row?.alarm) {
        await fire(f, row);
        const after = f.tables.projectHostedLandingRequests.get(row._id);
        assert.equal(after.noCarryWait, true, 'still held while the holder checks');
        assert.equal(after.runnable, false);
        assert.equal(after.alarm, null, 'the alarm clears itself, as a Ready order waiter does');
        quiet = tick;
        return;
      }
      if (quiet === undefined || lostRelease !== undefined) return;
      const release = f.pending().find(task => task.name === 'projectHostedLandingNoCarry:release');
      if (!release) return;
      f.patch('_scheduled_functions', release._id, { state: { kind: 'canceled' } });
      lostRelease = tick;
      const stranded = f.tables.projectHostedLandingRequests.get(row._id);
      assert(stranded.alarm, "the exit re-armed the held change's stall alarm");
      await fire(f, stranded);
      fallback = f.tables.projectHostedLandingRequests.get(row._id);
    },
  });
  assert(quiet !== undefined && lostRelease !== undefined, JSON.stringify({ quiet, lostRelease }));
  assert.equal(fallback.noCarryWait, undefined, 'the stall alarm released the hold');
  assert.equal(fallback.orderWait, undefined);
  assert.equal(fallback.orderWaits.at(-1).release, 'holder-exit');
  assert.notEqual(r.landedAt[3], undefined, 'and it landed');
  assert.equal(r.idle, 0);
});

test('incident 1018d0f8: switch off, nothing is held', async t => {
  process.env.FORGE_QUEUE_NO_CARRY_HOLD = '0';
  t.after(() => (process.env.FORGE_QUEUE_NO_CARRY_HOLD = '1'));
  assert.equal(noCarryHoldOn(), false);
  const r = await run(t, late(6));
  assert(noCarryWaits(r).every(w => !w.length));
  assert.equal(lost(r), 1088, 'today');
});

test('noCarryHold: only a checking holder with its step spent and its own order-sensitive risk', () => {
  const entries = ['convex/schema.ts', '.github/**'];
  const holder = {
    phase: 'checking',
    priority: 'normal',
    attemptId: 'a',
    runId: 'r',
    admitted: false,
    overtaken: 'earlier:generation',
    parked: false,
  };
  assert.equal(noCarryHold(['src/a.ts'], ['convex/schema.ts'], entries, holder), true);
  assert.equal(
    noCarryHold(['src/a.ts'], ['convex/schema.ts'], entries, { ...holder, overtaken: undefined }),
    false,
    'unspent',
  );
  assert.equal(
    noCarryHold(['src/a.ts'], ['convex/schema.ts'], entries, { ...holder, phase: 'ready' }),
    false,
    'not checking',
  );
  assert.equal(
    noCarryHold(['src/a.ts'], ['src/b.ts'], entries, holder),
    false,
    'holder without order-sensitive risk',
  );
  assert.equal(noCarryHold(['.github/x.yml'], ['convex/schema.ts'], entries, holder), false, 'own risk');
  assert.equal(
    noCarryHold(['src/a.ts'], ['src/a.ts', 'convex/schema.ts'], entries, holder),
    false,
    'paths overlap: an ordinary conflict, not risk-only',
  );
});

test('no-carry hold setting declaration is complete', () => {
  for (const key of ['setting', 'default', 'signal', 'formula', 'bounds', 'override', 'reason', 'judgedOn'])
    assert(typeof NO_CARRY_HOLD_SETTING[key] === 'string' && NO_CARRY_HOLD_SETTING[key].length > 20, key);
  assert(NO_CARRY_HOLD_SETTING.override.includes('Manual mode hint'));
  assert(NO_CARRY_HOLD_SETTING.touches.length >= 3);
});

test('status names the submission a held change waits for and why', () => {
  const wait = landingOrderWaitForReader(
    {
      phase: 'queued',
      orderWait: 'holder-1',
      noCarryWait: true,
      orderWaits: [{ submissionId: 'holder-1', held: 'no-carry', footprints: 'disjoint', at: 1 }],
    },
    { phase: 'queued' },
  );
  assert.equal(wait.submissionId, 'holder-1');
  assert.equal(wait.held, 'no-carry');
  assert.match(wait.message, /holder-1/);
  assert.match(wait.message, /order-sensitive/);
});
