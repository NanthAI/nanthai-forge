#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// B1.5d summary across cells (PLAN.md "Analysis"): per arm and N, the median and range over
// reps; per overlap class, landed-clean rate and added minutes (a task's time to main in the
// cell minus its median time to main at N = 1 in the same arm). Every cell is listed, void
// or not; void cells and contaminated or harness-error tasks are excluded from the numbers.
//   node scripts/bench-t3code/summarize.mjs [--dry] > summary.json
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { benchRootOrExit } from './bench-root.mjs';
import { summarizeRunners, runnerFairness } from './runners.mjs';
import { reworkSummary } from './rework.mjs';

const B = benchRootOrExit();
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
const usableAll = cells.filter(r => !r.voided?.length && inValidBatch.has(r.cellId));
// Coordination cells (cells.mjs) have their own N and tasks; they never mix into byArmN.
const usable = usableAll.filter(r => !r.coordinationCell);
const coordinationCells = usableAll.filter(r => r.coordinationCell);
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
        runner: b.runner ?? null,
        cells: (b.cells ?? []).map(c => c.cellId),
        voided: b.voided ?? [],
      })),
      runnersByArm: Object.fromEntries(
        ['forge', 'github'].map(arm => [
          arm,
          {
            ...summarizeRunners(cells.filter(c => c.arm === arm).flatMap(c => c.runner?.jobs ?? [])),
            cellsWithoutFullEvidence: cells
              .filter(c => c.arm === arm && !Array.isArray(c.runner?.jobs))
              .map(c => c.cellId),
          },
        ]),
      ),
      runnerDisclosures: batches.map(b => ({
        batchId: b.batchId,
        ...runnerFairness(
          (b.cells ?? []).map(c => ({ ...c, runner: cells.find(r => r.cellId === c.cellId)?.runner })),
          b.mode,
        ),
      })),
      outliers: Object.fromEntries(
        [1, 3, 5, 10]
          .map(N => [N, join(B, `outlier-n${N}${dry ? '-dry' : ''}.json`)])
          .filter(([, f]) => existsSync(f))
          .map(([N, f]) => {
            const d = JSON.parse(readFileSync(f, 'utf8'));
            return [`N=${N}`, { extraReps: d.extraReps, outliers: d.outliers }];
          }),
      ),
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
        runner: r.runner?.jobs ? summarizeRunners(r.runner.jobs) : { fullEvidence: false },
        filesystemEvents: r.gates?.filesystemEvents ?? null,
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
      // Headline rule (PLAN.md Outlier rule): byArmN is over all valid reps, extra reps
      // included; this sensitivity view leaves the outlier rule's extra reps out.
      withoutExtraReps: Object.fromEntries(
        [...new Set(usable.map(r => `${r.arm} N=${r.N}`))].map(k => {
          const list = usable.filter(r => `${r.arm} N=${r.N}` === k && !r.extra);
          return [
            k,
            {
              cells: list.length,
              wallSeconds: range(list.map(r => r.wallSecondsToAllLanded)),
              timeToMainSeconds: range(list.flatMap(r => okTasks(r).map(t => t.timeToMainSeconds ?? null))),
              landed: range(list.map(r => r.landed)),
              strict: range(list.map(r => r.oracle?.grade?.strictSuccess ?? null)),
            },
          ];
        }),
      ),
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
      // Compare episodes in both arms; old per-call results are unknown, never relabeled.
      conflictEpisodes: usable.map(r => {
        const tasks = r.coordination?.perTask ?? [];
        return {
          key: r.key,
          arm: r.arm,
          N: r.N,
          episodes:
            tasks.length && tasks.every(t => t.conflictEpisodes != null)
              ? tasks.reduce((n, t) => n + t.conflictEpisodes, 0)
              : null,
          rawConflictCalls:
            r.arm === 'forge'
              ? tasks.reduce((n, t) => n + (t.conflictCalls ?? t.syncConflicts ?? 0), 0)
              : null,
          rawMergeConflictOutputs:
            r.arm === 'github'
              ? tasks.reduce((n, t) => n + (t.mergeConflictOutputs ?? t.mergeConflicts ?? 0), 0)
              : null,
        };
      }),
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
      // Rework tokens and turns per landing (phases.mjs), Forge against GitHub with bootstrap
      // intervals over the reps; coordination cells: convoy verdicts and the stacking A/B.
      rework: reworkSummary(usable, coordinationCells),
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
