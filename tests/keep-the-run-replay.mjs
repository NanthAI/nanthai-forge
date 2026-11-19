// SPDX-License-Identifier: Apache-2.0
// Keep the run (Item fa2c1383): replay of the recorded 11-17 window (incident 5e3c3a3c) through two
// arms of the main-move decision. Baseline: today's sweep (tests/keep-the-run-baseline.mjs). Keep:
// src/stale-check-keep.ts. The trace is the read-only extraction in
// tests/fixtures/keep-the-run-1117-trace.mjs. This is a model on recorded walls and outcomes: it
// does not re-run the queue, so second-order effects (a landing that lands earlier moves main
// earlier for others) are not modelled. Every choice it cannot observe leans against the keep arm:
// - every recorded wait that is not a run (queue, order, red main, compose) is kept as recorded, so
//   time to main moves only by the run wall the keep changes; that run wall is reported on its own;
// - a run retired later after all shifts its whole recorded replacement chain by the extra time;
// - main is red from a mover whose audit failed until the next mover whose audit did not;
// - shared Markdown is taken as a tested doc and the fast mode as off on main, so docs overlaps
//   never carry; red runs of submissions that never landed are not in the trace (no red-run credit).
import recorded from './fixtures/keep-the-run-1117-trace.mjs';
import { scopedRecheckPays, staleCheckDisposition } from '../dist/stale-check-keep.js';
import { STANDARD_CHECK_INPUTS } from '../dist/standard-check.js';
import { globPattern } from '../dist/autonomy-policy.js';
import { STANDARD_ENTRIES, coverageMover, globalMover, todayKeeps } from './keep-the-run-baseline.mjs';

export const trace = () => ({
  ...structuredClone(recorded),
  paths: Buffer.from(recorded.paths, 'base64').toString('utf8').split('\n'),
});

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null;
};
const sum = values => values.reduce((a, b) => a + b, 0);
/** A cancel inside the accepting transaction ends the run within seconds of the mover's commit. */
const MAIN_MOVE_SECONDS = 5;

/** Length in minutes of the union of the runs' intervals. */
const unionMinutes = runs => {
  let total = 0;
  let reach = -Infinity;
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const from = Math.max(run.startedAt, reach);
    if (run.endedAt > from) total += run.endedAt - from;
    reach = Math.max(reach, run.endedAt);
  }
  return total / 60;
};

/** `laneB`: project Lane B (probe first) by keeping an overlapping run whose probe is clean, under the
 * same scoped-recheck payback. Every landing in the window landed, so none of its overlaps was a real
 * text conflict on its final base; this is a projection for the Item target, not the rule this Lane
 * ships. `scopedScale` projects selector precision (Item 5dcfce75) by scaling the recorded scoped
 * recheck's wall and job-minutes; 1 is the record. */
export function replayKeepTheRun(t = trace(), { laneB = false, scopedScale = 1 } = {}) {
  const landings = t.landings.map(l => ({ ...l, paths: l.paths.map(i => t.paths[i]) }));
  const byId = new Map(landings.map(l => [l.id, l]));
  // A batch publishes one commit: one mover per commit time.
  const movers = [...new Map(landings.map(l => [l.committedAt, l])).values()].sort(
    (a, b) => a.committedAt - b.committedAt,
  );
  // Main is red from a failed audit's mover until the next mover whose audit did not fail.
  const redSpans = movers
    .filter(m => m.auditFailed)
    .map(m => [
      m.committedAt,
      movers.find(n => n.committedAt > m.committedAt && !n.auditFailed)?.committedAt ?? Infinity,
    ]);
  const redAt = time => redSpans.some(([from, to]) => time >= from && time < to);
  const wall = run => (run.endedAt - run.startedAt) / 60;
  const passed = t.runs.filter(r => r.status === 'passed' && r.billedMinutes !== null);
  // Cancelled runs report no billed time: estimate it from passed runs' billed share of wall x shards.
  const billedShare = sum(passed.map(r => r.billedMinutes)) / sum(passed.map(r => wall(r) * r.shards));
  const jobMinutes = r => r.billedMinutes ?? wall(r) * r.shards * billedShare;
  const wholePasses = passed.filter(r => r.gate !== 'scoped');
  const scopedPasses = passed.filter(r => r.gate === 'scoped');
  const fallback = {
    wall: median(wholePasses.map(wall)),
    jobs: median(wholePasses.map(r => r.billedMinutes)),
  };
  // Recheck attempts: a landing's own passed runs after its first passed whole run. One that fell
  // back to the full suite (scoped-root-config, scoped-unclassified) counts at a whole run's cost, so
  // the share is not optimistic by the fallback rate (review 563c595b).
  const passedWholeAt = new Map();
  for (const run of wholePasses)
    if (run.landings.length === 1)
      passedWholeAt.set(
        run.landings[0],
        Math.min(passedWholeAt.get(run.landings[0]) ?? Infinity, run.endedAt),
      );
  const fellBack = passed.filter(
    r =>
      r.gate === 'full' &&
      r.landings.length === 1 &&
      r.startedAt >= (passedWholeAt.get(r.landings[0]) ?? Infinity),
  );
  const attempts = [
    ...scopedPasses.map(r => ({ wall: wall(r), jobs: r.billedMinutes })),
    ...fellBack.map(() => ({ wall: fallback.wall, jobs: fallback.jobs })),
  ];
  const scoped = {
    wall: median(attempts.map(a => a.wall)) * scopedScale,
    jobs: median(attempts.map(a => a.jobs)) * scopedScale,
    shards: median(scopedPasses.map(r => r.shards)),
  };
  // The project's own measured costs, as the sweep would read them. No red-share credit: the trace
  // holds no red first check of a landed submission.
  const scopedShare = { jobs: scoped.jobs / fallback.jobs, wall: scoped.wall / fallback.wall };
  const economicsAt = (run, time) => ({
    elapsed: (time - run.startedAt) / 60 / fallback.wall,
    scopedShare,
    redShare: 0,
  });
  const protectedPath = [...t.policy.protectedPaths, ...STANDARD_CHECK_INPUTS].map(globPattern);
  const disposition = (run, mover) => {
    const decided = ruleFor(run, mover);
    if (!(laneB && decided.reason === 'code-overlap' && run.gate === 'full' && !redAt(mover.committedAt)))
      return decided;
    return scopedRecheckPays(economicsAt(run, mover.committedAt))
      ? { action: 'keep', reason: 'scoped-recheck', holdOrder: true }
      : { action: 'cancel', reason: 'scoped-costs-more' };
  };
  const ruleFor = (run, mover) => {
    const owners = run.landings.map(id => byId.get(id));
    const paths = [...new Set(owners.flatMap(l => l.paths))];
    const changed = mover.paths;
    return staleCheckDisposition({
      acceptance: t.policy,
      reducedEvidence: true, // every landing in the window is the owner's agent, accepted automatically
      landing: {
        recovery: false,
        revert: false,
        cohort: run.gate === 'batch-full' || owners.length > 1,
        semanticPlan: false,
      },
      run: { gate: run.gate === 'scoped' ? 'partial' : 'full', standard: true, direct: true },
      paths,
      changed,
      checkEntries: STANDARD_ENTRIES,
      globalMover: globalMover(changed),
      coverageMover: coverageMover(changed),
      main: { status: redAt(mover.committedAt) ? 'red' : 'green', debt: false },
      protectedPaths: paths.some(path => protectedPath.some(glob => glob.test(path))),
      economics: economicsAt(run, mover.committedAt),
      fastMain: false, // the audit window is not in the trace; never assume the fast relaxation
    });
  };

  const cancels = [];
  const runsOf = new Map(landings.map(l => [l.id, []]));
  for (const run of t.runs) for (const id of run.landings) runsOf.get(id).push(run);
  for (const run of t.runs) {
    if (run.status !== 'cancelled') continue;
    const mover = movers.findLast(
      m =>
        m.committedAt >= run.startedAt &&
        m.committedAt <= run.endedAt &&
        run.endedAt - m.committedAt <= MAIN_MOVE_SECONDS,
    );
    if (mover) cancels.push({ run, mover });
  }
  const cancelOf = new Map(cancels.map(c => [c.run.id, c]));
  const calibration = {
    mainMoveCancels: cancels.length,
    // Today's rule must explain every recorded main-move cancel; a mismatch means the reconstruction
    // (paths or mover) is off for that run, and the replay then keeps it cancelled in both arms.
    baselineAgrees: cancels.filter(
      c =>
        !todayKeeps({
          globalMover: globalMover(c.mover.paths),
          paths: c.run.landings.flatMap(id => byId.get(id).paths),
          changed: c.mover.paths,
        }),
    ).length,
    redSpans: redSpans.length,
    scopedShare,
    full: fallback,
    scoped: { wall: scoped.wall, jobs: scoped.jobs },
    recheckAttempts: attempts.length,
    recheckFellBack: fellBack.length,
    // Elapsed share of the median whole wall at each recorded main-move cancel.
    elapsed: cancels.map(c => wall(c.run) / fallback.wall),
    landingsWithCancels: new Set(cancels.flatMap(c => c.run.landings)).size,
  };

  const arms = { baseline: [], keep: [] };
  const reasons = {};
  const outcomes = {};
  const count = (map, key) => (map[key] = (map[key] ?? 0) + 1);
  for (const landing of landings) {
    const runs = runsOf.get(landing.id).sort((a, b) => a.startedAt - b.startedAt);
    const own = runs.filter(r => r.landings.length === 1);
    const cost = rs => sum(rs.map(r => jobMinutes(r) / r.landings.length));
    const cancelled = rs => rs.filter(r => cancelOf.has(r.id));
    const base = {
      id: landing.id,
      runnerMinutes: cost(runs),
      cancelledJobMinutes: cost(cancelled(runs)),
      cancelledWallMinutes: sum(cancelled(runs).map(r => wall(r) / r.landings.length)),
      timeToMainMinutes: (landing.committedAt - landing.submittedAt) / 60,
      runWallMinutes: unionMinutes(runs),
    };
    arms.baseline.push(base);
    let keep = base;
    for (const [index, run] of runs.entries()) {
      const hit = cancelOf.get(run.id);
      if (!hit) continue;
      const first = disposition(run, hit.mover);
      count(reasons, first.reason);
      if (first.action !== 'keep' || first.reason === 'unrelated') continue;
      // The kept run runs to its recorded whole wall: this landing's own whole pass, else the median.
      const ownPasses = own.filter(r => r.status === 'passed' && r.gate !== 'scoped');
      const W = median(ownPasses.map(wall)) ?? fallback.wall;
      const J = median(ownPasses.map(r => r.billedMinutes)) ?? fallback.jobs;
      const end = Math.max(run.startedAt + W * 60, hit.mover.committedAt);
      const before = runs.slice(0, index);
      // Every later mover before it ends is swept again with the same rule: one may retire it after
      // all, and one that leaves only a scoped recheck downgrades a carry.
      let final = first.reason;
      let later = null;
      for (const m of movers) {
        if (m.committedAt <= hit.mover.committedAt || m.committedAt >= end || m.id === landing.id) continue;
        const again = disposition(run, m);
        if (again.action === 'cancel') {
          later = m;
          break;
        }
        if (again.reason === 'scoped-recheck') final = 'scoped-recheck';
      }
      if (later) {
        // Retired later after all: it ran longer before the cancel, and (pessimistically) the whole
        // recorded replacement chain still runs, shifted by that extra time.
        count(outcomes, 'retired-later');
        const extraMinutes = (later.committedAt - run.endedAt) / 60;
        const extra = extraMinutes * run.shards * billedShare;
        keep = {
          ...base,
          runnerMinutes: base.runnerMinutes + extra,
          cancelledJobMinutes: base.cancelledJobMinutes + extra,
          cancelledWallMinutes: base.cancelledWallMinutes + extraMinutes,
          timeToMainMinutes: base.timeToMainMinutes + extraMinutes,
          runWallMinutes: base.runWallMinutes + extraMinutes,
        };
        break;
      }
      count(outcomes, first.reason === 'carry' && final !== 'carry' ? 'carry-downgraded' : final);
      // Kept to its end: it replaces this run and its whole recorded replacement chain. A carry lands
      // at once; otherwise today's scoped recheck runs on the kept pass (recorded scoped medians).
      const recheck = { wall: 0, jobs: 0, cancelledJobs: 0, cancelledWall: 0 };
      if (final === 'scoped-recheck') {
        // The scoped recheck is itself swept by later movers (a partial run retires on a global
        // mover). Each retire pays the retired run's time and restarts it on the inherited basis.
        let at = end;
        // A red main also refuses it (acceptScopedRecheck), whatever the mover's paths.
        for (let hits = 0; hits < 10; hits++) {
          const next = movers.find(
            m =>
              m.committedAt > at &&
              m.committedAt <= at + scoped.wall * 60 &&
              m.id !== landing.id &&
              (redAt(m.committedAt) || disposition({ ...run, gate: 'scoped' }, m).action === 'cancel'),
          );
          if (!next) {
            recheck.wall += scoped.wall;
            recheck.jobs += scoped.jobs;
            break;
          }
          const minutes = (next.committedAt - at) / 60;
          recheck.wall += minutes;
          recheck.jobs += minutes * scoped.shards * billedShare;
          recheck.cancelledJobs += minutes * scoped.shards * billedShare;
          recheck.cancelledWall += minutes;
          at = next.committedAt;
        }
      }
      const keptWall = (end - run.startedAt) / 60 + recheck.wall;
      keep = {
        ...base,
        runnerMinutes: cost(before) + J + recheck.jobs,
        cancelledJobMinutes: cost(cancelled(before)) + recheck.cancelledJobs,
        cancelledWallMinutes:
          sum(cancelled(before).map(r => wall(r) / r.landings.length)) + recheck.cancelledWall,
        // Recorded non-run waits stay: only the replaced run wall changes.
        timeToMainMinutes: base.timeToMainMinutes - unionMinutes(runs.slice(index)) + keptWall,
        runWallMinutes: unionMinutes(before) + keptWall,
      };
      break;
    }
    arms.keep.push(keep);
  }
  const round = value => Math.round(value * 10) / 10;
  const totals = rows => ({
    cancelledJobMinutes: Math.round(sum(rows.map(r => r.cancelledJobMinutes))),
    cancelledWallMinutes: Math.round(sum(rows.map(r => r.cancelledWallMinutes))),
    runnerMinutes: Math.round(sum(rows.map(r => r.runnerMinutes))),
    timeToMainP50Minutes: round(median(rows.map(r => r.timeToMainMinutes))),
    timeToMainMeanMinutes: round(sum(rows.map(r => r.timeToMainMinutes)) / rows.length),
    runWallMinutes: Math.round(sum(rows.map(r => r.runWallMinutes))),
    runWallMeanMinutes: round(sum(rows.map(r => r.runWallMinutes)) / rows.length),
  });
  return {
    calibration,
    reasons,
    outcomes,
    landings: landings.length,
    baseline: totals(arms.baseline),
    keep: totals(arms.keep),
    rows: arms,
  };
}
