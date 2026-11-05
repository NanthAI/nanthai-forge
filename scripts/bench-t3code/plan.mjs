#!/usr/bin/env node
// B1.5d pre-registered design (PLAN.md). Everything a cell's order depends on is derived
// here from fixed inputs, so the schedule is known before the first cell runs:
//   node scripts/bench-t3code/plan.mjs json   -> the machine-readable plan (batches; rep-3 candidates)
//   node scripts/bench-t3code/plan.mjs check  -> exits 1 unless BENCH_ROOT/PLAN.md and
//                                               tasks.json match this plan
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DESIGN = Object.freeze({
  ns: [1, 3, 5, 10],
  arms: ['github', 'forge'],
  // Owner run design 2026-11-01: reps 1 and 2 always; rep 3 for an N only when its reps 1
  // and 2 are "too different" (rep3Decision). Fixed before the first cell.
  reps: 2,
  maxReps: 3,
  // Never more than this many agents at once, across both arms.
  maxAgents: 10,
  // N where the Forge and GitHub cells of one rep run at the same time (same machine load);
  // other N run one arm after the other, the first arm alternating between reps.
  concurrentNs: [1, 3, 5],
  // Primary metrics of the rep-3 rule and how "better" reads for each.
  primary: { timeToMain: 'lower', landed: 'higher', strict: 'higher' },
  rep3Spread: 0.25,
  seed: 'b15d-rerun-2026-11-01',
  // Tasks that touch the same files are dispatched back to back as one unit (random
  // position, random inner order), so at N >= 2 they normally run at the same time: the
  // Pi pair (same files, references merge clean), the Codex pair (one test-file conflict)
  // and the preview triple (two conflicting pairs and one clean control).
  dispatchGroups: [
    ['t27514', 't27521'],
    ['t23938', 't23766'],
    ['t19456', 't22302', 't27456'],
  ],
  // A batch with a void cell (infrastructure reasons) is re-run once, whole, after the reps
  // it belongs to. Both attempts are published.
  maxAttempts: 2,
  // A batch whose every cell crashed in setup before any agent ran (reset, clock probe,
  // barrier: infrastructure, not an arm) is not an attempt; it is re-run, up to this many
  // times, and disclosed as setup-only in its batch.json.
  maxSetupRetries: 2,
  tasksSha256: 'dc4346af484794cc181a953b37a42c132b9bf57abcd4b6a0b871e3f84c7b52f1',
});

/** Deterministic 32-bit PRNG seeded from a string (sha256 -> mulberry32). */
export function rng(seedText) {
  let a = createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates with the given random source. */
function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Fisher-Yates over the task ids with each dispatch group kept together as one unit
 * (its inner order shuffled first, groups in DESIGN order). A group missing any of its
 * tasks is not kept together. */
export function taskOrder(taskIds, seedText, groups = DESIGN.dispatchGroups) {
  const random = rng(seedText);
  const together = groups.filter(g => g.every(id => taskIds.includes(id)));
  const grouped = new Set(together.flat());
  const units = [
    ...taskIds.filter(id => !grouped.has(id)).map(id => [id]),
    ...together.map(g => shuffle([...g], random)),
  ];
  return shuffle(units, random).flat();
}

export const cellSeed = (N, rep) => `${DESIGN.seed}/n${N}/r${rep}`;
export const cellKey = (arm, N, rep) => `${arm}-n${N}-r${rep}`;

/** Sequential N: which arm goes first in a rep (GitHub in odd reps, Forge in even ones). */
export const firstArm = rep => (rep % 2 === 1 ? 'github' : 'forge');

/** One batch = both arms' cells of one (N, rep), sharing one task order and one freeze
 * window. Concurrent N start both cells together; sequential N run them in `cells` order. */
export function batch(taskIds, N, rep) {
  const order = taskOrder(taskIds, cellSeed(N, rep));
  const concurrent = DESIGN.concurrentNs.includes(N);
  const arms = concurrent ? ['forge', 'github'] : rep % 2 === 1 ? ['github', 'forge'] : ['forge', 'github'];
  return {
    key: `n${N}-r${rep}`,
    N,
    rep,
    seed: cellSeed(N, rep),
    mode: concurrent ? 'concurrent' : 'sequential',
    agentsAtOnce: concurrent ? 2 * N : N,
    order,
    cells: arms.map(arm => ({ key: cellKey(arm, N, rep), arm, N, rep, seed: cellSeed(N, rep), order })),
  };
}

/** N order within a rep (owner, 2026-11-01): odd reps descending, so the hardest batch
 * (N = 10) runs first and a Forge failure under load shows early; rep 2 ascending, which
 * balances order effects across N. */
export function repNs(rep) {
  return [...DESIGN.ns].sort((a, b) => (rep % 2 ? b - a : a - b));
}

/** Batches of the given reps, reps outer, N in repNs order inner. */
export function batches(taskIds, reps = [1, 2]) {
  return reps.flatMap(rep => repNs(rep).map(N => batch(taskIds, N, rep)));
}

/** Attempt state for `nextBatch`: a setup-only void (no agent ran in either arm) does not
 * consume an attempt. */
export const SETUP_ONLY = 'setup-only';

/** Index of the next batch to run, given each batch's attempts in plan order (false = valid,
 * true = void, SETUP_ONLY = void before any agent ran): the first with no valid attempt,
 * fewer than DESIGN.maxAttempts consuming attempts and at most DESIGN.maxSetupRetries
 * setup-only ones; -1 when all are done. A void batch is re-run before the next starts, and
 * a resume continues in the same order. */
export function nextBatch(history, maxAttempts = DESIGN.maxAttempts, maxSetup = DESIGN.maxSetupRetries) {
  return history.findIndex(states => {
    const setup = states.filter(s => s === SETUP_ONLY).length;
    return states.every(Boolean) && states.length - setup < maxAttempts && setup <= maxSetup;
  });
}

/** Every cell any batch may run (reps 1-3), for run-cell's lookup by key. */
export function schedule(taskIds) {
  const reps = Array.from({ length: DESIGN.maxReps }, (_, i) => i + 1);
  return batches(taskIds, reps)
    .flatMap(b => b.cells)
    .map((cell, index) => ({ index, ...cell }));
}

const medianOf = xs => {
  const v = xs.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/** The three primary metrics of one cell result (contaminated, quota and harness-error
 * tasks excluded, as in the analysis). */
export function primaryMetrics(result) {
  const voids = new Set(result.taskVoids ?? []);
  const ok = (result.records ?? []).filter(r => r && !r.harnessError && !voids.has(r.task));
  return {
    timeToMain: medianOf(ok.filter(r => r.landing?.landed).map(r => r.timeToMainSeconds)),
    landed: ok.filter(r => r.landing?.landed).length,
    strict: result.oracle?.grade?.strictSuccess ?? null,
  };
}

/** +1 Forge better, -1 GitHub better, 0 tie or unknown. */
function winner(metric, forge, github) {
  if (forge == null || github == null || forge === github) return 0;
  const forgeBetter = DESIGN.primary[metric] === 'lower' ? forge < github : forge > github;
  return forgeBetter ? 1 : -1;
}
/** Relative spread between two readings of one metric: |a-b| / min(a,b); a change from 0. */
export function spread(a, b) {
  if (a == null || b == null) return null;
  if (a === b) return 0;
  const lo = Math.min(Math.abs(a), Math.abs(b));
  return lo === 0 ? Infinity : Math.abs(a - b) / lo;
}

/** Pre-registered rep-3 rule for one N, from the valid results of reps 1 and 2:
 * rep[r] = { forge, github } (cell results; null when that rep has no valid cell). Rep 3 runs
 * when the Forge-vs-GitHub winner flips on a primary metric (one rep Forge strictly better,
 * the other GitHub strictly better), when any primary metric of either arm differs by more
 * than 25% between the reps, or when rep 1 or 2 has no valid cell after its re-run. */
export function rep3Decision(rep1, rep2) {
  const reasons = [];
  for (const [r, pair] of [
    [1, rep1],
    [2, rep2],
  ])
    for (const arm of DESIGN.arms) if (!pair?.[arm]) reasons.push(`rep ${r} ${arm} has no valid cell`);
  if (reasons.length) return { run: true, reasons, metrics: null };
  const m = [rep1, rep2].map(p => ({ forge: primaryMetrics(p.forge), github: primaryMetrics(p.github) }));
  for (const metric of Object.keys(DESIGN.primary)) {
    const w = m.map(x => winner(metric, x.forge[metric], x.github[metric]));
    if (w[0] * w[1] === -1)
      reasons.push(
        `${metric}: winner flips (${w[0] > 0 ? 'Forge' : 'GitHub'} -> ${w[1] > 0 ? 'Forge' : 'GitHub'})`,
      );
    for (const arm of DESIGN.arms) {
      const s = spread(m[0][arm][metric], m[1][arm][metric]);
      if (s == null) reasons.push(`${metric}: ${arm} unreadable in rep ${m[0][arm][metric] == null ? 1 : 2}`);
      else if (s > DESIGN.rep3Spread)
        reasons.push(
          `${metric}: ${arm} ${m[0][arm][metric]} vs ${m[1][arm][metric]} (${s === Infinity ? 'from 0' : Math.round(s * 100) + '%'} > 25%)`,
        );
    }
  }
  return { run: reasons.length > 0, reasons, metrics: m };
}

export function loadTasks(benchRoot) {
  const raw = readFileSync(join(benchRoot, 'tasks.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const sha = createHash('sha256').update(JSON.stringify(parsed.tasks)).digest('hex');
  if (sha !== DESIGN.tasksSha256) throw Error(`BENCH_TASKS_CHANGED ${sha}`);
  return parsed.tasks;
}

// Committed as docs (no test reads it); BENCH_ROOT/PLAN.md must be a byte-identical copy.
export const planPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), '../../docs/research/b15d-bench-plan.md');
export const planSha = text => createHash('sha256').update(text).digest('hex');

/** The plan the driver follows: design, schedule and the PLAN.md text hash. */
export function plan(benchRoot) {
  const tasks = loadTasks(benchRoot);
  const text = readFileSync(planPath(), 'utf8');
  return {
    design: DESIGN,
    planSha256: planSha(text),
    tasks: tasks.map(t => ({ id: t.id, pr: t.pr, overlap: t.overlap })),
    batches: batches(tasks.map(t => t.id)),
    rep3Candidates: DESIGN.ns.map(N =>
      batch(
        tasks.map(t => t.id),
        N,
        3,
      ),
    ),
  };
}

/** BENCH_ROOT/PLAN.md must be the committed PLAN.md, byte for byte. */
export function checkPlan(benchRoot) {
  const committed = readFileSync(planPath(), 'utf8');
  let copy = null;
  try {
    copy = readFileSync(join(benchRoot, 'PLAN.md'), 'utf8');
  } catch {}
  const problems = [];
  if (copy !== committed) problems.push('BENCH_ROOT/PLAN.md differs from the committed PLAN.md');
  try {
    loadTasks(benchRoot);
  } catch (error) {
    problems.push(error.message);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const benchRoot = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
  if (process.argv[2] === 'json') console.log(JSON.stringify(plan(benchRoot), null, 1));
  else if (process.argv[2] === 'check') {
    const problems = checkPlan(benchRoot);
    console.log(problems.length ? problems.join('\n') : 'plan ok');
    process.exit(problems.length ? 1 : 0);
  } else throw Error('usage: plan.mjs json|check');
}
