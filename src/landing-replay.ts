// SPDX-License-Identifier: Apache-2.0
import { localCost } from './check-cost.js';
import { ReplayPlanner } from './landing-replay-planner.js';
import type { LandingBatch } from './landing-batch-types.js';
import { passingPrefix } from './landing-batch-check.js';
import { actionsCost, actionsRate } from './check-cost.js';
import { distribution, trainAccounting, type CostCategory, type CostRun } from './train-accounting.js';

export type ReplayWorkload = {
  name: string;
  arrivals: { id: string; atMs: number; overlap?: string; conflict?: boolean }[];
  failingSets?: string[][];
  repairedBy?: string;
  infrastructure?: 'rejected' | 'lost-reply' | 'retry' | 'cancelled' | 'late' | 'stale-main';
  restartBoundary?: string;
  preview?: boolean;
};
const arrivals = (count: number, step = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: String.fromCharCode(65 + i), atMs: i * step }));
export function syntheticWorkloads(): ReplayWorkload[] {
  return [
    { name: 'eight-clean', arrivals: arrivals(8) },
    {
      name: 'same-paragraph-conflict',
      arrivals: arrivals(4).map((row, i) => ({ ...row, overlap: 'paragraph', conflict: i === 2 })),
    },
    { name: 'cross-file-interaction', arrivals: arrivals(2), failingSets: [['A', 'B']], preview: true },
    {
      name: 'higher-order-interaction',
      arrivals: arrivals(3),
      failingSets: [['A', 'B', 'C']],
      preview: true,
    },
    { name: 'non-monotone', arrivals: arrivals(4), failingSets: [['A', 'B'], ['D']], repairedBy: 'C' },
    ...(['rejected', 'lost-reply', 'retry', 'cancelled', 'late', 'stale-main'] as const).map(
      infrastructure => ({ name: infrastructure, arrivals: arrivals(10, 1), infrastructure }),
    ),
    ...['selection', 'composition', 'check-reservation', 'evaluation', 'acceptance-receipt'].map(
      restartBoundary => ({ name: `restart-${restartBoundary}`, arrivals: arrivals(8), restartBoundary }),
    ),
  ];
}

/** Deterministic discrete-event reference planners, not a live provider benchmark.
 * Uses the production selector, overlap planner and remote-prefix evaluator. CI failure
 * fixtures are explicit model inputs, not a prediction of production throughput.
 * Durations are fake CI observations; no wall-clock scheduling assertions. */
export async function replayLanding(workload: ReplayWorkload, planner: 'serial' | 'train') {
  const production = new ReplayPlanner(workload, planner);
  try {
    return await replay(workload, planner, production);
  } finally {
    production.dispose();
  }
}
async function replay(workload: ReplayWorkload, planner: 'serial' | 'train', production: ReplayPlanner) {
  const pending = workload.arrivals.map(row => ({ ...row })),
    accepted: string[] = [],
    outcomes: Record<string, string> = {};
  const waits: number[] = [],
    queue: number[] = [],
    trace: { event: string; atMs: number; ids: string[] }[] = [];
  const runs: CostRun[] = [],
    category = new Map<string, CostCategory>();
  const active: {
    ids: string[];
    base: string[];
    at: number;
    passing: string[];
    failing?: string;
    stopped?: string;
    runs: string[];
    batch: LandingBatch;
  }[] = [];
  let now = 0,
    ordinal = 0,
    injected = false,
    dispatchRejections = 0,
    adopted = 0,
    previewFeedbackMs: number | null = null;
  const stamp = (time: number) => new Date(Date.UTC(2026, 0, 1) + time).toISOString();
  const fails = (ids: string[]) =>
    (workload.failingSets ?? []).some(
      set =>
        set.every(id => ids.includes(id)) &&
        !(workload.repairedBy && !set.includes('D') && ids.includes(workload.repairedBy)),
    );
  const previews: import('./train-accounting.js').PreviewMeasurement[] = [];
  const check = (ids: string[], start: number, purpose: CostCategory, retry = false) => {
    const id = `execution-${++ordinal}`,
      seconds = 300;
    const cost = actionsCost(
      'blacksmith-4vcpu-ubuntu-2404',
      actionsRate('blacksmith-4vcpu-ubuntu-2404'),
      (retry ? [seconds] : [120, seconds, seconds, seconds, seconds]).map((duration, index) => ({
        id: ordinal * 10 + index,
        status: 'completed',
        started_at: stamp(start),
        completed_at: stamp(start + duration * 1000),
        retry,
      })),
    );
    runs.push({
      id,
      startedAt: stamp(start),
      endedAt: stamp(start + seconds * 1000),
      backend: { actual: 'github-actions', requested: 'github-actions', cost },
    });
    category.set(id, purpose);
    trace.push({ event: purpose, atMs: start, ids });
    return id;
  };
  if (workload.preview) {
    // Same fake static duration and controls for both strategies; preview never gates landing.
    const inputs = pending.map(row => row.id);
    const controls = [[], ...inputs.map(id => [id]), inputs];
    const observations = controls.map(ids => ({
      ids,
      status: fails(ids) ? 'failed' : 'passed',
      startMs: 0,
      endMs: 10,
    }));
    previewFeedbackMs =
      Math.max(...observations.map(row => row.endMs)) - Math.min(...observations.map(row => row.startMs));
    previews.push({
      executionId: 'synthetic-preview',
      startedAt: stamp(0),
      durationMs: previewFeedbackMs,
      inputs: inputs.map(id => ({ laneId: id, head: id })),
      cost: localCost('synthetic-preview'),
    });
    for (const observation of observations)
      trace.push({ event: `preview-${observation.status}`, atMs: observation.endMs, ids: observation.ids });
  }
  while (pending.length || active.length) {
    while (active.length < (planner === 'serial' ? 1 : 4)) {
      const planned = production.take(now, new Set(active.map(row => row.batch.id)));
      if (!planned) break;
      const selected = pending.filter(
        row => planned.ids.includes(row.id) || planned.conflicts.includes(row.id),
      );
      for (const row of selected) pending.splice(pending.indexOf(row), 1);
      const members = planned.ids.map(id => workload.arrivals.find(row => row.id === id)!);
      for (const id of planned.conflicts) {
        outcomes[id] = 'conflict';
        waits.push(now - workload.arrivals.find(row => row.id === id)!.atMs);
      }
      if (!members.length) {
        production.finish(planned.batch, [], undefined, undefined, now);
        continue;
      }
      for (const row of members) queue.push(now - row.atMs);
      const ids = members.map(row => row.id),
        base = active.at(-1)?.base.concat(active.at(-1)!.ids) ?? [...accepted];
      const runIds: string[] = [];
      let end = now + 300_000,
        diagnosticStart = end;
      const firstFault = !injected && workload.infrastructure;
      if (firstFault) injected = true;
      if (firstFault === 'rejected') dispatchRejections++;
      if (firstFault === 'lost-reply' || workload.restartBoundary) adopted++;
      if (firstFault === 'late') end += 1000;
      const prefixes = ids.map((_, index) => ({
        entryIds: ids.slice(0, index + 1),
        viewId: `prefix-${index}`,
        head: 'synthetic',
        runId: `unused-${index}`,
      }));
      const evaluated = new Map<string, 'passed' | 'failed' | 'cancelled'>();
      const result = await passingPrefix(prefixes, 'parallel', async prefix => {
        const key = prefix.viewId,
          known = evaluated.get(key);
        if (known) return known;
        const full = prefix === prefixes.at(-1),
          at = full ? now : diagnosticStart;
        runIds.push(check([...base, ...prefix.entryIds], at, full ? 'landing' : 'diagnosis'));
        if (!full) end = Math.max(end, at + 300_000);
        if (full && firstFault === 'retry') {
          runIds.push(check([...base, ...prefix.entryIds], end, 'retry', true));
          end += 300_000;
          diagnosticStart = end;
        }
        const status =
          full && firstFault === 'cancelled'
            ? 'cancelled'
            : fails([...base, ...prefix.entryIds])
              ? 'failed'
              : 'passed';
        evaluated.set(key, status);
        return status;
      });
      active.push({
        ids,
        batch: planned.batch,
        base,
        at: end,
        passing: result.passing?.entryIds ?? [],
        ...(result.culprit ? { failing: result.culprit.entryIds.at(-1)! } : {}),
        ...(result.stopped ? { stopped: result.stopped } : {}),
        runs: runIds,
      });
      if (firstFault === 'stale-main') {
        accepted.push('external-main');
        production.externalMain(now);
      }
    }
    const arrival = pending.find(row => row.atMs > now)?.atMs ?? Infinity;
    const next = active[0];
    if (!next) {
      if (Number.isFinite(arrival)) {
        now = arrival;
        continue;
      }
      break;
    }
    if (arrival < next.at && active.length < (planner === 'serial' ? 1 : 4)) {
      now = arrival;
      continue;
    }
    now = Math.max(now, next.at);
    active.shift();
    if (!production.current(next.batch)) {
      // Every already launched descendant carries the invalid predecessor base.
      for (const invalid of [next, ...active.splice(0)]) {
        production.invalidate(invalid.batch);
        for (const id of invalid.runs) category.set(id, 'invalidated-speculation');
        pending.push(...invalid.ids.map(id => workload.arrivals.find(row => row.id === id)!));
        trace.push({ event: 'invalidate', atMs: now, ids: invalid.ids });
      }
      pending.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
      continue;
    }
    production.finish(next.batch, next.passing, next.failing, next.stopped, now);
    for (const id of next.ids) {
      if (next.passing.includes(id)) {
        accepted.push(id);
        outcomes[id] = 'accepted';
      } else if (id === next.failing || next.stopped) outcomes[id] = next.stopped ?? 'failed';
      else {
        pending.push(workload.arrivals.find(row => row.id === id)!);
        continue;
      }
      waits.push(now - workload.arrivals.find(row => row.id === id)!.atMs);
    }
  }
  // One coalesced full-main audit for both reference planners.
  if (accepted.some(id => id !== 'external-main')) check(accepted, now, 'audit');
  const summary = trainAccounting(runs, { previews });
  // Model run purposes are explicit and physical items still use the same accounting reducer.
  const byCategory = Object.fromEntries(
    [...new Set(category.values())].map(purpose => {
      const selected = runs.filter(run => category.get(run.id) === purpose);
      return [purpose, { checks: selected.length, ...trainAccounting(selected).total }];
    }),
  );
  return {
    workload: workload.name,
    planner,
    basis:
      'Synthetic replay of production train selection/overlap/prefix evaluation versus one-entry serial selection; logical fake CI milliseconds, not elapsed production performance.',
    outcomes,
    checkExecutions: runs.length,
    jobMinutes: runs.reduce((n, run) => n + (run.backend?.cost?.billedMinutes ?? 0), 0),
    allowanceUnits: Object.values(summary.categories).reduce((n, group) => n + group.allowanceUnits, 0),
    previewExecutions: previews.length,
    dispatchRejections,
    controllerAdoptions: adopted,
    previewFeedbackMs,
    submitToOutcome: distribution(waits),
    queue: distribution(queue),
    total: summary.total,
    byCategory: {
      ...byCategory,
      preview: { checks: previews.length, ...trainAccounting([], { previews }).total },
    },
    trace,
  };
}
