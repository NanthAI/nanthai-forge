// SPDX-License-Identifier: Apache-2.0
// Owner-local, read-only analysis. No SDK, network, billing, or source execution.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { modalUsageCost, MODAL_COST_SAFETY_MARGIN } from '../dist/modal-cost.js';

export function backtest(runs, journalFor, through) {
  const result = {
    through,
    recordedRuns: 0,
    oldEstimateUsd: 0,
    recomputedEstimateUsd: null,
    recomputableRuns: 0,
    missingJournals: 0,
    missingWorkerRuntimeExecutions: 0,
    controllerOverLifetimeExecutions: 0,
    controllerOverLifetimeSeconds: 0,
    knownEstimateUsd: 0,
    safetyMargin: MODAL_COST_SAFETY_MARGIN,
  };
  const seen = new Set();
  for (const run of runs) {
    if (
      !run.startedAt.startsWith(through.slice(0, 7)) ||
      run.startedAt.slice(0, 10) > through ||
      run.backend?.actual === 'github-actions' ||
      run.backend?.estimatedCostUsd === undefined
    )
      continue;
    result.recordedRuns++;
    result.oldEstimateUsd += run.backend.estimatedCostUsd;
    const executions = journalFor(run.id)?.executions;
    if (!executions) {
      result.missingJournals++;
      continue;
    }
    let complete = true;
    for (const item of executions) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (!Number.isFinite(item.seconds) || item.seconds < 0) {
        complete = false;
        result.missingWorkerRuntimeExecutions++;
        const elapsed = (item.ended ?? item.stopped) - item.started;
        if (elapsed > 900) {
          result.controllerOverLifetimeExecutions++;
          result.controllerOverLifetimeSeconds += elapsed - 900;
        }
        continue;
      }
      result.knownEstimateUsd += modalUsageCost({
        cpuCoreSeconds: Math.max(0.125, item.cpu ?? 2) * item.seconds,
        memoryGiBSeconds: (Math.max(128, item.memory ?? 4096) / 1024) * item.seconds,
        safetyMargin: MODAL_COST_SAFETY_MARGIN,
      });
    }
    if (complete) result.recomputableRuns++;
  }
  if (result.recomputableRuns === result.recordedRuns) result.recomputedEstimateUsd = result.knownEstimateUsd;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , owner, through] = process.argv;
  if (!owner || !/^\d{4}-\d{2}-\d{2}$/.test(through ?? ''))
    throw Error('Usage: node scripts/modal-cost-backtest.mjs OWNER YYYY-MM-DD');
  const { WorkStore } = await import('../dist/work-store.js');
  const store = new WorkStore(owner);
  const report = store.observing(() => {
    const runs = [];
    for (let offset = 0; ;) {
      const page = store.page('runs', offset, 100);
      runs.push(...page.records);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return backtest(
      runs,
      id => {
        try {
          return JSON.parse(
            readFileSync(join(store.directory, `check-${id}`, 'modal-executions.json'), 'utf8'),
          );
        } catch (error) {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }
      },
      through,
    );
  });
  console.log(JSON.stringify(report, null, 2));
}
