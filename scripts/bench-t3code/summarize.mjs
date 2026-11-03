#!/usr/bin/env node
// B1.5d summary across cells (PLAN.md "Analysis"): per arm and N, the median and range over
// reps; per overlap class, landed-clean rate and added minutes (a task's time to main in the
// cell minus its median time to main at N = 1 in the same arm). Every cell is listed, void
// or not; void cells and contaminated or harness-error tasks are excluded from the numbers.
//   node scripts/bench-t3code/summarize.mjs [--dry] > summary.json
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const B = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
const dry = process.argv.includes('--dry');
const median = xs => {
  const v = xs.filter(x => x != null).sort((a, b) => a - b);
  return v.length
    ? v.length % 2
      ? v[(v.length - 1) / 2]
      : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
    : null;
};
const cells = readdirSync(join(B, 'runs'))
  .filter(d => /-a\d+-/.test(d) && d.includes('-dry-') === dry && !d.includes('-modelcheck-'))
  .map(d => join(B, 'runs', d, 'result.json'))
  .filter(existsSync)
  .map(f => JSON.parse(readFileSync(f, 'utf8')))
  .filter(r => !r.refused);
// A cell counts only inside a valid batch (both arms under one freeze, same versions); cells
// run outside the driver (no batch) are listed but never scored.
const batchDir = join(B, 'batches');
const batches = existsSync(batchDir)
  ? readdirSync(batchDir)
      .filter(d => existsSync(join(batchDir, d, 'batch.json')))
      .map(d => JSON.parse(readFileSync(join(batchDir, d, 'batch.json'), 'utf8')))
      .filter(b => Boolean(b.dry) === dry)
  : [];
const inValidBatch = new Set(
  batches.filter(b => !b.voided?.length).flatMap(b => (b.cells ?? []).map(c => c.cellId)),
);
const usable = cells.filter(r => !r.voided?.length && inValidBatch.has(r.cellId));
const okTasks = r =>
  (r.records ?? []).filter(t => t && !t.harnessError && !(r.taskVoids ?? []).includes(t.task));
const baseline = {};
for (const r of usable.filter(c => c.N === 1))
  for (const t of okTasks(r)) ((baseline[r.arm] ??= {})[t.task] ??= []).push(t.timeToMainSeconds);
const byArmN = {},
  classes = {};
for (const r of usable) {
  const k = `${r.arm} N=${r.N}`;
  const s = (byArmN[k] ??= {
    cells: 0,
    wallSeconds: [],
    landed: [],
    strict: [],
    lenient: [],
    tokens: [],
    convexUsd: [],
    convexActionGbHours: [],
    convexActionComputeUsd: [],
    ciBilledMinutes: [],
    // Per task (PLAN.md, Same workspace-prep rule): prep is outside time to main, shown next to it.
    timeToMainSeconds: [],
    prepSeconds: [],
  });
  s.cells++;
  s.wallSeconds.push(r.wallSecondsToAllLanded);
  s.landed.push(r.landed);
  s.strict.push(r.oracle?.grade?.strictSuccess ?? null);
  s.lenient.push(r.oracle?.grade?.lenientScore ?? null);
  s.tokens.push(r.tokens ? Object.values(r.tokens).reduce((a, b) => a + b, 0) : null);
  s.convexUsd.push(r.convex?.valid === false ? null : (r.convex?.costUsd ?? null));
  // Older results' zero actionGbHours predate compute coverage; do not score them.
  const hasCompute = r.convex?.valid !== false && r.convex?.actionComputeUsd != null;
  s.convexActionGbHours.push(hasCompute ? (r.convex.actionGbHours ?? null) : null);
  s.convexActionComputeUsd.push(hasCompute ? r.convex.actionComputeUsd : null);
  s.ciBilledMinutes.push(r.ci?.billedMinutes ?? null);
  for (const t of okTasks(r)) {
    s.timeToMainSeconds.push(t.timeToMainSeconds ?? null);
    s.prepSeconds.push(t.prepSeconds ?? null);
  }
  const clean = new Map((r.coordination?.perTask ?? []).map(t => [t.task, t.clean]));
  for (const t of okTasks(r)) {
    const c = (classes[`${r.arm} N=${r.N} ${String(t.overlap).split(' ')[0]}`] ??= {
      tasks: 0,
      landedClean: 0,
      addedMinutes: [],
    });
    c.tasks++;
    if (clean.get(t.task)) c.landedClean++;
    const b = median(baseline[r.arm]?.[t.task] ?? []);
    if (b != null && t.timeToMainSeconds != null) c.addedMinutes.push((t.timeToMainSeconds - b) / 60);
  }
}
const range = xs => {
  const v = xs.filter(x => x != null);
  return {
    median: median(v),
    min: v.length ? Math.min(...v) : null,
    max: v.length ? Math.max(...v) : null,
    n: v.length,
  };
};
console.log(
  JSON.stringify(
    {
      batches: batches.map(b => ({
        batchId: b.batchId,
        mode: b.mode,
        cells: (b.cells ?? []).map(c => c.cellId),
        voided: b.voided ?? [],
      })),
      rep3: Object.fromEntries(
        [1, 3, 5, 10]
          .map(N => [N, join(B, `rep3-n${N}${dry ? '-dry' : ''}.json`)])
          .filter(([, f]) => existsSync(f))
          .map(([N, f]) => {
            const d = JSON.parse(readFileSync(f, 'utf8'));
            return [`N=${N}`, { run: d.run, reasons: d.reasons }];
          }),
      ),
      cells: cells.map(r => ({
        cellId: r.cellId,
        key: r.key,
        attempt: r.attempt,
        voided: r.voided ?? [],
        taskVoids: r.taskVoids ?? [],
        convex: r.convex
          ? {
              valid: r.convex.valid,
              problems: r.convex.problems,
              actionGbHours: r.convex.actionGbHours,
              actionComputeUsd: r.convex.actionComputeUsd ?? null,
              costUsd: r.convex.costUsd,
            }
          : null,
      })),
      byArmN: Object.fromEntries(
        Object.entries(byArmN).map(([k, s]) => [
          k,
          Object.fromEntries(Object.entries(s).map(([m, v]) => [m, Array.isArray(v) ? range(v) : v])),
        ]),
      ),
      overlapClasses: Object.fromEntries(
        Object.entries(classes).map(([k, c]) => [
          k,
          {
            tasks: c.tasks,
            landedCleanRate: c.tasks ? c.landedClean / c.tasks : null,
            addedMinutes: range(c.addedMinutes),
          },
        ]),
      ),
      metric4: usable
        .filter(r => r.arm === 'forge' && r.N >= 3)
        .map(r => ({ key: r.key, ...r.coordination?.metric4 })),
      // Useful (the notice pointed at a real same-hunk conflict) vs noise, per notice class.
      noticePrecision: usable
        .filter(r => r.arm === 'forge')
        .reduce((m, r) => {
          for (const [k, c] of Object.entries(r.coordination?.metric4?.byClass ?? {})) {
            const t = (m[k] ??= { notices: 0, useful: 0, noise: 0, unknown: 0, acknowledged: 0 });
            for (const f of Object.keys(t)) t[f] += c[f] ?? 0;
          }
          m.missedRealConflicts =
            (m.missedRealConflicts ?? 0) + (r.coordination?.metric4?.missed?.length ?? 0);
          return m;
        }, {}),
      // Leftover land-gate cost per Forge task (preflight after save, unanswered overlap).
      forgeGateTime: Object.fromEntries(
        Object.entries(
          usable
            .filter(r => r.arm === 'forge')
            .reduce((m, r) => {
              for (const t of r.coordination?.perTask ?? [])
                (m[`N=${r.N}`] ??= []).push(
                  (t.gateTime?.preflightLostSeconds ?? 0) + (t.gateTime?.overlapLostSeconds ?? 0),
                );
              return m;
            }, {}),
        ).map(([k, v]) => [k, range(v)]),
      ),
    },
    null,
    1,
  ),
);
