// SPDX-License-Identifier: Apache-2.0
// Core-claim incident 43b51a5e, case 2 (dogfood 2026-11-19 16:53-17:16Z): passed landings handed
// from one waited-on entry to the next waited out every head's re-check, whatever their paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { drive, overlapBase, overlapEdits } from './queue-sim/overtake-drive.mjs';
import { moduleUrl } from './convex-module.mjs';
const wake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const { overtakeMark, overtakeRiskOnly, ownGlobalRisk, waitFootprints } = await import(
  moduleUrl('../src/landing-overtake.ts')
);
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-handoff',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const row = (f, id) => [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
const queueShape = { admissionCheck: false, requestCheck: true, batching: false };
const LANE = 150,
  RECHECK = 300,
  SLOW = 1000,
  FOLLOWERS = 4;

test('overtakeRiskOnly: a parked Ready entry is overtaken once for its passed generation, one about to land never', () => {
  const ready = { phase: 'ready', attemptId: 'a1', runId: 'r1', admitted: false };
  assert.equal(overtakeRiskOnly({ ...ready, parked: false }), 'hold', 'a Ready entry about to land');
  assert.equal(overtakeRiskOnly({ ...ready, parked: true }), 'spend', 'a parked Ready entry is charged once');
  const mark = overtakeMark(ready);
  assert.equal(overtakeRiskOnly({ ...ready, parked: true, overtaken: mark }), 'free', 'same generation');
  assert.equal(
    overtakeRiskOnly({ ...ready, parked: true, overtaken: 'a0:r0' }),
    'hold',
    'overtaken in an earlier generation: strict order again',
  );
  assert.equal(
    overtakeRiskOnly({ ...ready, parked: true, priority: 'urgent' }),
    'hold',
    'urgent keeps order',
  );
  const checking = { phase: 'checking', attemptId: 'a1', runId: 'r1', admitted: false, parked: false };
  assert.equal(overtakeRiskOnly(checking), 'spend', 'a checking entry as overtakeOlder');
});

test('waitFootprints: an older-risk-only link is disjoint, a shared path or newer risk is overlap', () => {
  assert.equal(waitFootprints(['src/a.ts'], ['src/b.ts'], []), 'disjoint');
  assert.equal(
    waitFootprints(['src/a.ts'], ['convex/schema.ts'], []),
    'disjoint',
    "the older side's own risk",
  );
  assert.equal(
    waitFootprints(['convex/schema.ts'], ['src/b.ts'], []),
    'overlap',
    'the newer side carries risk',
  );
  assert.equal(waitFootprints(['src/a.ts'], ['src/a.ts'], []), 'overlap', 'a shared path');
  assert.equal(waitFootprints(null, ['src/b.ts'], []), 'overlap', 'unknown paths are never disjoint');
});

test('ownGlobalRisk: a change on a global-risk file is held by every holder; unknown paths are not', () => {
  assert.equal(ownGlobalRisk(['convex/schema.ts'], []), true, 'the database schema');
  assert.equal(ownGlobalRisk(['src/a.ts', 'convex/schema.ts'], []), true, 'one risk file is enough');
  assert.equal(ownGlobalRisk(['src/a.ts'], []), false);
  assert.equal(ownGlobalRisk(null, []), false, 'unknown paths: never held this way');
  assert.equal(ownGlobalRisk([], []), false);
});

/** The live shape. The head H0 checks for SLOW ticks and keeps strict order (it was overtaken in
 * an earlier generation and its pass cannot carry), so every passed entry parks on it: H1 (edits
 * H0's file), A (changes the database schema, its own global risk) and four followers with disjoint
 * paths. When H0 lands, its exit wake drives the oldest waiter, H1, and hands the rest to it. H1
 * must re-check (H0 moved main under its file), then A must re-check (its pass never carries).
 * Before the fix the followers were invisible to the new-run wake (their last recorded wait named
 * H0), and A, which cannot overtake, held the ones handed to it: they waited out both re-checks
 * (tick ~1600). Now they take main during H1's re-check, and nobody re-checks more because of it. */
test('incident replay 43b51a5e case 2: followers handed to a re-checking entry take main during its re-check', async t => {
  const r = await drive(t, {
    memberPaths: [
      'src/shared.ts',
      'src/shared.ts',
      'convex/schema.ts',
      ...Array.from({ length: FOLLOWERS }, (_, i) => `src/h${i}.ts`),
    ],
    baselineFiles: [['src/shared.ts', overlapBase]],
    memberContents: overlapEdits,
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: (i, nth) => (i === 0 ? SLOW : nth > 1 ? RECHECK : LANE),
    prepare(f, [head]) {
      f.patch('projectHostedLandingRequests', row(f, head)._id, {
        overtaken: 'earlier:generation',
        unsealed: 'not-eligible',
      });
    },
  });
  const [, h1, a] = r.ids;
  const followers = r.landedAt.slice(3);
  assert(r.landedAt[1] >= r.landedAt[0], 'H1 lands after the head it edits');
  assert(
    Math.max(...followers) < r.landedAt[0] + RECHECK / 4,
    `followers reached main by tick ${followers} (head landed ${r.landedAt[0]})`,
  );
  for (const [i, runs] of r.runs.slice(3).entries())
    assert.equal(runs, 1, `follower ${i} ran its own check only`);
  assert(r.runs[1] <= 2, `H1 re-checks once, for the head (${r.runs[1]} runs)`);
  assert(r.runs[2] <= 2, `A re-checks once, for its own risk (${r.runs[2]} runs)`);
  for (const [i, waits] of r.orderWaits.slice(3).entries())
    assert(
      !waits.some(w => [h1, a].includes(w.submissionId) && w.held === 'dependent'),
      `follower ${i} never waits as dependent on H1 or A: ${JSON.stringify(waits)}`,
    );
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
  // Measured on this replay before the fix (followers re-checked behind A's schema change): fewer now.
  // Re-measured without this fix on main d28cce4c: 443 -> 475.
  const baseline = { calls: 475 };
  assert(r.calls <= baseline.calls, `Convex transactions ${baseline.calls} -> ${r.calls}`);
});

/** A passed entry A whose only link to newer ones is its own global risk is Ready (taking main)
 * when four disjoint followers pass, so they park on it (`accepting`). Its proof is refused (main
 * moved; schema risk) and it re-checks for SLOW ticks. The new-run wake must find them: their wait
 * records disjoint footprints (the link is A's risk, not their paths) and the oldest one overtakes
 * A once. Before the fix the wait recorded `overlap` and they waited out A's whole re-check. */
test('43b51a5e case 2: followers parked on an older-risk entry are woken when it re-checks', async t => {
  const r = await drive(t, {
    memberPaths: [
      'src/first.ts',
      'convex/schema.ts',
      ...Array.from({ length: FOLLOWERS }, (_, i) => `src/p${i}.ts`),
    ],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: (i, nth) => (i === 0 ? 0 : nth > 1 ? SLOW : i === 1 ? LANE : LANE + 2),
  });
  const older = r.ids[1];
  // Its own check, the re-check the moved main forced, and at most one more for the overtake.
  assert(r.runs[1] <= 3, `A re-checks at most once for the followers (${r.runs[1]} runs)`);
  for (const [i, runs] of r.runs.slice(2).entries())
    assert.equal(runs, 1, `follower ${i} ran its own check only`);
  const landed = Math.max(...r.landedAt.slice(2));
  assert(landed < LANE + 2 + SLOW / 4, `followers reached main by tick ${landed}`);
  for (const waits of r.orderWaits.slice(2))
    for (const w of waits.filter(w => w.submissionId === older))
      assert.notEqual(
        w.footprints,
        'overlap',
        `a risk-only link is not a footprint overlap: ${JSON.stringify(w)}`,
      );
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
  // Measured on this replay before the fix (each follower re-checked behind A): fewer now.
  // Re-measured without this fix on main d28cce4c: 375 -> 401.
  const baseline = { calls: 401 };
  assert(r.calls <= baseline.calls, `Convex transactions ${baseline.calls} -> ${r.calls}`);
});

/** Review 8c3f272f finding 2, re-shaped by review 14cf6d7e F2: a wave deeper than the receipt's
 * order-wait list. The head H0 checks for SLOW ticks in strict order and edits w0; E1..E10 form a
 * pairwise-overlapping chain (Ek edits w(k-1) and wk), so only E1 overlaps H0, and four followers
 * change other files. H0's exit hands everyone to E1, which re-checks; its new-run wake drives E2,
 * which parks on E1 (shared w1) and passes its followers on (baton), and so on down the chain: the
 * followers are handed more than HOSTED_ORDER_WAITS times. A handoff is a mark (`orderWaitHanded`),
 * not a recorded wait, so receipts stay true and the followers stay eligible to the end. */
test('43b51a5e case 2: a wave deeper than ten handoffs keeps followers eligible and receipts true', async t => {
  const DEPTH = 10;
  const files = Array.from({ length: DEPTH + 1 }, (_, i) => `src/w${i}.ts`);
  const handed = new Map();
  const r = await drive(t, {
    memberPaths: [
      files[0],
      ...Array.from({ length: DEPTH }, (_, k) => [files[k], files[k + 1]]),
      ...Array.from({ length: FOLLOWERS }, (_, i) => `src/d${i}.ts`),
    ],
    baselineFiles: files.map(path => [path, overlapBase]),
    // Neighbours edit different lines of the file they share: overlapping paths, no conflict.
    memberContents: [overlapEdits[0], ...Array.from({ length: DEPTH }, (_, k) => overlapEdits[(k + 1) % 2])],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: (i, nth) => (i === 0 ? SLOW : nth > 1 ? RECHECK : LANE + i),
    prepare(f, [head]) {
      f.patch('projectHostedLandingRequests', row(f, head)._id, {
        overtaken: 'earlier:generation',
        unsealed: 'not-eligible',
      });
    },
    afterStep(f) {
      for (const entry of f.tables.projectHostedLandingRequests.values())
        if (entry.orderWaitHanded)
          handed.set(
            entry.submissionId,
            (handed.get(entry.submissionId) ?? new Set()).add(entry.orderWaitHanded),
          );
    },
  });
  const followers = r.landedAt.slice(DEPTH + 1);
  // Without the baton they wait out the chain's re-checks one by one; now they land at once.
  assert(
    Math.max(...followers) < r.landedAt[0] + RECHECK / 2,
    `followers reached main by tick ${followers} (head landed ${r.landedAt[0]})`,
  );
  for (const [i, runs] of r.runs.slice(DEPTH + 1).entries())
    assert.equal(runs, 1, `follower ${i} ran its own check only`);
  const last = r.ids.at(-1);
  assert(
    (handed.get(last)?.size ?? 0) > 8,
    `the last follower was handed past HOSTED_ORDER_WAITS (${handed.get(last)?.size ?? 0} holders)`,
  );
  const waves = new Set(r.ids.slice(1, DEPTH + 1));
  for (const [i, waits] of r.orderWaits.slice(DEPTH + 1).entries()) {
    assert(
      waits.length < 8,
      `follower ${i}: receipt waits are claim decisions only ${JSON.stringify(waits)}`,
    );
    assert(
      !waits.some(w => waves.has(w.submissionId) && w.held === 'dependent'),
      `follower ${i} never recorded a dependent wait on a wave entry`,
    );
  }
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
});

/** Review 14cf6d7e F1: a follower's overlap was with a holder that left without landing. H0 (strict
 * order, edits src/a.ts) is withdrawn while F, which also edits src/a.ts, waits on it; main did not
 * move, so F's pass still carries. H0's exit drives H1 (edits src/y.ts) and hands F to it; H1 then
 * parks for the whole check of Y, an older entry on its file. F is disjoint from H1 and Y, so the
 * baton on H1's park must drive it. Before the fix F's last wait (overlap, on H0) kept it parked
 * through Y's check and H1's re-check. */
test('43b51a5e F1: a follower overlapping a withdrawn holder takes main on its own pass', async t => {
  const LONG = 2 * SLOW;
  const r = await drive(t, {
    memberPaths: ['src/a.ts', 'src/y.ts', 'src/y.ts', 'src/a.ts'],
    baselineFiles: [
      ['src/a.ts', overlapBase],
      ['src/y.ts', overlapBase],
    ],
    memberContents: [overlapEdits[0], overlapEdits[0], overlapEdits[1], overlapEdits[1]],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: (i, nth) => (i === 0 ? SLOW : i === 1 ? LONG : nth > 1 ? RECHECK : LANE + i),
    withdraws: i => i === 0,
    prepare(f, [head]) {
      f.patch('projectHostedLandingRequests', row(f, head)._id, {
        overtaken: 'earlier:generation',
        unsealed: 'not-eligible',
      });
    },
  });
  const [, y, h1, follower] = r.landedAt;
  assert.equal(r.landedAt[0], undefined, 'the withdrawn head never lands');
  assert(follower < SLOW + RECHECK / 4, `F reached main by tick ${follower} (Y ${y}, H1 ${h1})`);
  assert.equal(r.runs[3], 1, 'F lands on its own pass');
  assert(h1 > y, 'H1 still waits for Y, which shares its file');
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
});

/** Review 8c3f272f: mixed followers are handed on together and each keeps its own rule. As the case-2
 * replay, plus a follower that edits a file the head changes (it must re-check after the head), one
 * that changes the database schema itself (newer risk: strict order behind A and H1) and a late
 * disjoint one that passes while A re-checks its second generation: A was already overtaken once, so
 * the late one waits for it as `overtaken` with disjoint footprints (bounded overtaking). Combined
 * groups keep strict order and are covered by the overtake replays; this queue shape has no batches. */
test('43b51a5e case 2: mixed handed followers keep their own rules and the second-generation bound', async t => {
  // Passes while A re-checks (after H1 lands, before A does).
  const late = SLOW + 450;
  const r = await drive(t, {
    memberPaths: [
      ['src/shared.ts', 'src/o.ts'],
      'src/shared.ts',
      'convex/schema.ts',
      'src/h0.ts',
      'src/h1.ts',
      'src/o.ts',
      'convex/schema.ts',
      'src/late.ts',
    ],
    baselineFiles: [
      ['src/shared.ts', overlapBase],
      ['src/o.ts', overlapBase],
      ['convex/schema.ts', overlapBase],
    ],
    memberContents: [overlapEdits[0], overlapEdits[1], overlapEdits[0], , , overlapEdits[1], overlapEdits[1]],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: (i, nth) => (i === 0 ? SLOW : i === 7 && nth === 1 ? late : nth > 1 ? RECHECK : LANE + i),
    prepare(f, [head]) {
      f.patch('projectHostedLandingRequests', row(f, head)._id, {
        overtaken: 'earlier:generation',
        unsealed: 'not-eligible',
      });
    },
  });
  const [head, h1, a, d0, d1, ov, risk, last] = r.landedAt;
  const ids = r.ids;
  assert(
    Math.max(d0, d1) < head + RECHECK / 4,
    `disjoint followers reached main by ${[d0, d1]} (head ${head})`,
  );
  assert.equal(r.runs[3], 1);
  assert.equal(r.runs[4], 1);
  // It re-checks for the head's change to its file and for A's schema change (order-sensitive).
  assert(
    ov > head && r.runs[5] <= 3,
    `the overlapping follower lands after the head (${ov}, ${r.runs[5]} runs)`,
  );
  assert(risk > a && risk > h1, `the schema follower keeps strict order behind A and H1 (${risk})`);
  assert(
    r.orderWaits[7].some(
      w => w.submissionId === ids[2] && w.held === 'overtaken' && w.footprints === 'disjoint',
    ),
    `the late follower waits for A's second generation: ${JSON.stringify(r.orderWaits[7])}`,
  );
  assert(r.runs[2] <= 3, `A pays at most one re-check for followers (${r.runs[2]} runs)`);
  // It passed before A's schema change and the schema follower landed: both are order-sensitive.
  assert(r.runs[7] <= 3, `the late follower re-checks only for the schema changes (${r.runs[7]} runs)`);
  assert(last > a, `it lands after A (${last})`);
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
});

/** Three live entries shaped directly: holder H, then Q (queued: a conflict cohort member or an
 * early resolution) and a Ready follower F, both parked on H, F's last claim disjoint from H. H's
 * exit wake drives Q and hands F to it; Q then binds a run (the new-run wake). */
async function queuedNextShape(t, follower = {}) {
  const f = await batchesFixture(t, { ...queueShape, count: 3, memberPaths: ['h.ts', 'q.ts', 'f.ts'] });
  await f.drain();
  const [H, Q, F] = f.entries.map(e => row(f, e.state.id));
  f.patch('projectHostedLandingRequests', Q._id, {
    phase: 'queued',
    orderLive: true,
    orderWait: H.submissionId,
  });
  f.patch('projectHostedLandingRequests', F._id, {
    phase: 'ready',
    orderLive: true,
    orderWait: H.submissionId,
    orderWaits: [{ submissionId: H.submissionId, held: 'accepting', footprints: 'disjoint' }],
    ...follower,
  });
  for (const finish of f.tables.projectHostedFinishes.values()) {
    const value = JSON.parse(finish.value);
    if (value.pending)
      f.patch('projectHostedFinishes', finish._id, {
        value: JSON.stringify({ ...value, pending: undefined }),
      });
  }
  const run = (name, fn) => f.transaction(name, { _handler: fn }, {});
  await run('holder-exit', ctx => wake.wakeLandingOrderWaiters(ctx, row(f, H.submissionId)));
  const handed = row(f, F.submissionId);
  assert.equal(handed.orderWait, Q.submissionId, 'the exit wake hands F to the queued entry it drove');
  await run('queued-next-binds-run', ctx => wake.wakeNewRunFollower(ctx, row(f, Q.submissionId)));
  return { handed, after: row(f, F.submissionId), Q };
}

// Re-check 120fcc09 finding 4: an exit wake can drive a queued entry first. The Ready followers
// handed to it got no mark, so when it bound a run the new-run wake found none of them: the case-2
// stall in this shape. Fails before the fix on the mark and on the drive.
test('43b51a5e F4: a Ready follower handed to a queued next is marked and driven when that entry binds a run', async t => {
  const { handed, after, Q } = await queuedNextShape(t);
  assert.equal(handed.orderWaitHanded, Q.submissionId, 'handed to a queued next, F carries the mark');
  assert.equal(after.orderWait, undefined, 'the new-run wake drives F, whose own claim decides');
});

// Review 012bd638 (non-blocking): an urgent claim skips every non-urgent older entry
// (olderLandingAhead), so an urgent change on a global-risk file is not held by its own risk.
test('43b51a5e: an urgent waiter with its own global risk is driven; a normal one stays held by its paths', async t => {
  const urgent = await queuedNextShape(t, { ownGlobalRisk: true, priority: 'urgent' });
  assert.equal(urgent.after.orderWait, undefined, 'the new-run wake drives the urgent own-risk waiter');
  const normal = await queuedNextShape(t, { ownGlobalRisk: true, priority: 'normal' });
  assert.equal(
    normal.after.orderWait,
    normal.Q.submissionId,
    'a normal own-risk waiter waits for its holder',
  );
});
