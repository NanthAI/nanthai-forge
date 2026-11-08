#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Rework tokens per landing, per cell and Forge against GitHub (Issue bf130503), from the phase
// classifier (phases.mjs) over each task's session, plus the convoy cell's pass rule and order
// waits. Intervals follow docs/agents/perf-claims.md (bootstrap of the median, fixed seed).
// Offline: reads a cell's retained files only.
//   node scripts/bench-t3code/rework.mjs RUN_DIR [RUN_DIR ...]   -> per-cell JSON
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapInterval } from '../bootstrap-interval.mjs';
import { jsonLines, sessionPhases, PHASES } from './phases.mjs';

const SEED = 1;
const median = xs => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/** Median of the values with its 95% bootstrap interval (resampling the values themselves). */
export function medianInterval(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { n: 0, median: null, ci95: null };
  const b = bootstrapInterval(v, { seed: SEED });
  return { n: b.n, median: b.medianDifference, ci95: b.ci95, smallSample: b.smallSample };
}

/** One task's rework line: tokens and turns per phase plus the episode counters. */
export function taskLine(task, landed, p) {
  const t = p.totals ?? Object.fromEntries(PHASES.map(k => [k, {}]));
  const pick = k => ({
    turns: t[k].turns ?? 0,
    cachedInput: t[k].cachedInput ?? 0,
    output: t[k].output ?? 0,
    input: t[k].input ?? 0,
    cacheWrite: t[k].cacheWrite ?? 0,
  });
  return {
    task,
    landed: Boolean(landed),
    source: p.source,
    rework: pick('rework'),
    waiting: pick('waiting'),
    landing: pick('landing'),
    coding: pick('coding'),
    reworkEpisodes: p.events?.reworkEpisodes ?? 0,
    triggers: (p.events?.triggers ?? []).flatMap(x => x.kinds),
    resyncs: p.events?.resyncs ?? 0,
    landingAttempts: p.events?.attempts ?? 0,
    joined: p.joined ?? null,
  };
}

/** Per-cell summary: per-landing medians with intervals, sums, and per-landing means
 * (cell sum / landings, so tokens of tasks that never landed still count against the arm). */
export function cellRework(lines) {
  const landedLines = lines.filter(l => l.landed);
  const sum = (key, field) => lines.reduce((a, l) => a + l[key][field], 0);
  const per = (key, field) => medianInterval(landedLines.map(l => l[key][field]));
  const landings = landedLines.length;
  return {
    tasks: lines.length,
    landings,
    perLanding: {
      reworkCachedInput: per('rework', 'cachedInput'),
      reworkOutput: per('rework', 'output'),
      reworkTurns: per('rework', 'turns'),
      waitingTurns: per('waiting', 'turns'),
      reworkEpisodes: medianInterval(landedLines.map(l => l.reworkEpisodes)),
    },
    sums: {
      reworkCachedInput: sum('rework', 'cachedInput'),
      reworkOutput: sum('rework', 'output'),
      reworkTurns: sum('rework', 'turns'),
      waitingTurns: sum('waiting', 'turns'),
      waitingCachedInput: sum('waiting', 'cachedInput'),
      reworkEpisodes: lines.reduce((a, l) => a + l.reworkEpisodes, 0),
      resyncs: lines.reduce((a, l) => a + l.resyncs, 0),
    },
    meanPerLanding: landings
      ? {
          reworkCachedInput: sum('rework', 'cachedInput') / landings,
          reworkOutput: sum('rework', 'output') / landings,
          reworkTurns: sum('rework', 'turns') / landings,
          waitingTurns: sum('waiting', 'turns') / landings,
        }
      : null,
    lines,
  };
}

/** Forge against GitHub at one N: pairs are the reps (same N, rep and task order), the value
 * a cell's mean per landing; difference Forge minus GitHub (negative = Forge less rework). */
export function compareArms(pairs, metric = 'reworkCachedInput') {
  const usable = pairs.filter(p => p.github?.meanPerLanding && p.forge?.meanPerLanding);
  if (!usable.length) return { metric, n: 0, note: 'no rep with both arms landed' };
  const b = bootstrapInterval(
    usable.map(p => [p.github.meanPerLanding[metric], p.forge.meanPerLanding[metric]]),
    { seed: SEED },
  );
  return {
    metric,
    pairs: usable.map(p => ({
      rep: p.rep,
      github: p.github.meanPerLanding[metric],
      forge: p.forge.meanPerLanding[metric],
    })),
    ...b,
    forgeLower: b.ci95[1] < 0,
    label: b.smallSample ? `observation (${b.n} pairs < 11)` : 'interval',
  };
}

/** Lane check wall per landed task, seconds. Forge: the landed submission's check
 * (checkReservedAt to ciEndedAt); GitHub: the PR's last passing pull_request run. */
export function checkWalls(arm, records, runList = []) {
  const out = new Map();
  for (const r of records) {
    if (!r.landing?.landed) continue;
    if (arm === 'forge') {
      const t = (r.landing.operations ?? []).find(o => o.phase === 'landed')?.timing;
      const s = (Date.parse(t?.ciEndedAt) - Date.parse(t?.checkReservedAt)) / 1000;
      if (Number.isFinite(s)) out.set(r.task, s);
    } else {
      const prs = new Set(r.landing.prs ?? []);
      const run = runList
        .filter(x => prs.has(x.pr) && x.event === 'pull_request' && x.conclusion === 'success')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .at(-1);
      const s = run ? (Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000 : NaN;
      if (Number.isFinite(s)) out.set(r.task, s);
    }
  }
  return out;
}

/** Order waits the agents were shown (relay rows' `orderWaits`, broker.mjs): which older
 * submission each task waited behind, and whose it is: the task that reported it as its own
 * submission, else the one other task it was shown to; null = outside the cell or unknown. */
export function orderWaits(calls) {
  const index = key => {
    const m = new Map();
    for (const c of calls)
      for (const id of c[key] ?? []) (m.get(id) ?? m.set(id, new Set()).get(id)).add(c.task);
    return m;
  };
  const owners = index('submissionIds'),
    shownTo = index('ids');
  const waits = [];
  for (const c of calls)
    for (const id of c.orderWaits ?? []) {
      const own = [...(owners.get(id) ?? [])].filter(t => t !== c.task);
      const shown = [...(shownTo.get(id) ?? [])].filter(t => t !== c.task);
      const peers = own.length ? own : shown;
      waits.push({ task: c.task, waitedFor: id, at: c.endedAt, peer: peers.length === 1 ? peers[0] : null });
    }
  // One wait per (task, submission), however many reads repeated it.
  const seen = new Set();
  return waits.filter(w => !seen.has(`${w.task}:${w.waitedFor}`) && seen.add(`${w.task}:${w.waitedFor}`));
}

/** Convoy cell pass rule (8c9b84fc, binding at N = 16): every task landed, each time to main
 * <= factor x median Lane check wall + slack, and no order wait against an independent entry
 * (every pair in a convoy cell is independent by construction: different packages, new files). */
export function convoyVerdict(records, walls, waits, { factor = 1.3, slackSeconds = 120 } = {}) {
  const wall = median([...walls.values()]);
  const limit = wall == null ? null : factor * wall + slackSeconds;
  const late = records
    .filter(r => !r.landing?.landed || limit == null || !(r.timeToMainSeconds <= limit))
    .map(r => ({
      task: r.task,
      landed: Boolean(r.landing?.landed),
      timeToMainSeconds: r.timeToMainSeconds ?? null,
    }));
  const independentWaits = waits.filter(w => w.peer);
  const unknownWaits = waits.filter(w => !w.peer);
  return {
    medianCheckWallSeconds: wall,
    limitSeconds: limit,
    late,
    orderWaitsAgainstIndependent: independentWaits.length,
    orderWaitsUnattributed: unknownWaits.length,
    waits,
    pass: limit != null && !late.length && !independentWaits.length && !unknownWaits.length,
  };
}

const METRICS = ['reworkCachedInput', 'reworkOutput', 'reworkTurns', 'waitingTurns'];
const slotOf = r => (r.coordinationCell?.stack ? `${r.arm}-${r.coordinationCell.stack}` : r.arm);

/** Every metric of one A/B: cells of arm slot `a` against `b`, paired by rep (an extra rep is
 * its own pair). Difference b minus a; negative = b has less rework. */
function abMetrics(cells, a, b) {
  const byRep = new Map();
  for (const r of cells) {
    if (!r.rework?.landings && r.rework?.landings !== 0) continue;
    const rep = `${r.rep}${r.extra ? 'x' : ''}`;
    const pair = byRep.get(rep) ?? byRep.set(rep, { rep }).get(rep);
    if (slotOf(r) === a) pair.github = r.rework;
    if (slotOf(r) === b) pair.forge = r.rework;
  }
  const pairs = [...byRep.values()];
  return { a, b, ...Object.fromEntries(METRICS.map(m => [m, compareArms(pairs, m)])) };
}

/** Rework section of the bench summary. Main cells: Forge against GitHub per N (binding line:
 * rework tokens and turns per landing lower at every N). Coordination cells: per kind and N,
 * each Forge arm against GitHub, the stacking A/B (auto against offer) and the convoy verdicts. */
export function reworkSummary(mainCells, coordinationCells = []) {
  const ns = cells => [...new Set(cells.map(r => r.N))].sort((x, y) => x - y);
  const main = Object.fromEntries(
    ns(mainCells).map(N => [
      `N=${N}`,
      abMetrics(
        mainCells.filter(r => r.N === N),
        'github',
        'forge',
      ),
    ]),
  );
  const coordination = {};
  for (const kind of ['convoy', 'overlap'])
    for (const N of ns(coordinationCells.filter(r => r.coordinationCell.kind === kind))) {
      const cells = coordinationCells.filter(r => r.coordinationCell.kind === kind && r.N === N);
      const slots = [...new Set(cells.map(slotOf))].sort();
      coordination[`${kind} N=${N}`] = {
        vsGithub: slots.filter(x => x !== 'github').map(x => abMetrics(cells, 'github', x)),
        ...(slots.includes('forge-offer') && slots.includes('forge-auto')
          ? { stackingAB: abMetrics(cells, 'forge-offer', 'forge-auto') }
          : {}),
        ...(kind === 'convoy'
          ? {
              convoy: cells.map(r => ({
                cellId: r.cellId,
                arm: slotOf(r),
                pass: r.rework?.convoy?.pass ?? null,
                limitSeconds: r.rework?.convoy?.limitSeconds ?? null,
                late: r.rework?.convoy?.late?.length ?? null,
                orderWaitsAgainstIndependent: r.rework?.convoy?.orderWaitsAgainstIndependent ?? null,
                orderWaitsUnattributed: r.rework?.convoy?.orderWaitsUnattributed ?? null,
              })),
            }
          : {}),
      };
    }
  return { main, coordination };
}

/** Rework (and the convoy rule for convoy cells) of one retained run directory. */
export function runRework(dir) {
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  const callLog = join(dir, 'nforge-calls.jsonl');
  const calls = existsSync(callLog) ? jsonLines(readFileSync(callLog, 'utf8')) : [];
  const lines = (result.records ?? []).map(r =>
    taskLine(
      r.task,
      r.landing?.landed,
      sessionPhases(join(dir, 'agents', r.task), {
        rows: result.arm === 'forge' ? calls.filter(c => c.task === r.task) : null,
      }),
    ),
  );
  const out = { cellId: result.cellId, arm: result.arm, N: result.N, rep: result.rep, ...cellRework(lines) };
  if (result.coordinationCell?.kind === 'convoy')
    out.convoy = convoyVerdict(
      result.records,
      checkWalls(result.arm, result.records, result.ci?.runList ?? []),
      orderWaits(calls),
    );
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) throw Error('usage: rework.mjs RUN_DIR [RUN_DIR ...]');
  console.log(JSON.stringify(dirs.map(runRework), null, 1));
}
