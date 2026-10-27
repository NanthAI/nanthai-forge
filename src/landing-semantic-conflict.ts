// SPDX-License-Identifier: Apache-2.0
import { candidateContractReports } from './agent-contract-timings.js';
import { semanticVerdict, semanticConflictMessage } from './intent-semantic-conflict.js';
import { batchEdit } from './landing-batch-store.js';
import type { WorkService } from './work.js';
import type { CheckRun } from './work-types.js';
import type { LandingBatch, BatchPrefix } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

/** Reuse the exact check's reports, including a retained Q3 source; never dispatch a second run. */
export async function retainSemanticConflict(
  work: WorkService,
  batch: LandingBatch,
  prefix: BatchPrefix,
  run: CheckRun,
  driver: LandingDriver,
) {
  const view = work.store.select('views', prefix.viewId);
  if (!view?.semanticPlan || !['passed', 'failed'].includes(run.status)) return false;
  const original = run.reusedFrom ? work.store.select('runs', run.reusedFrom.runId) : run;
  if (!original) return false;
  const reports = await candidateContractReports(work.store, original.id, original.viewId, original.head);
  const verdict = semanticVerdict(view.semanticPlan, reports.reports, {
    candidateId: view.id,
    head: prefix.head,
    runId: run.id,
  });
  if (!verdict.conflicts.length && !verdict.overBudget) return false;
  await batchEdit(
    work,
    batch.id,
    data => {
      const entry = data.landingEntries!.find(entry => entry.id === prefix.entryIds.at(-1))!;
      if (entry.status !== 'checking') return;
      entry.runId = run.id;
      entry.terminalAt = new Date().toISOString();
      delete entry.waitingFor;
      if (verdict.overBudget) {
        entry.status = 'failed';
        entry.error = {
          code: 'CONTRACT_OVER_BUDGET',
          message: `Composed contract union measured ${verdict.overBudget.measuredMs} ms; budget is under 90000 ms for Intents ${verdict.overBudget.intents.join(' + ')}.`,
        };
        entry.reason = entry.error.message;
      } else {
        entry.status = 'conflict';
        entry.conflictViewId = view.id;
        entry.semanticConflicts = verdict.conflicts;
        entry.error = {
          code: 'INTENT_SEMANTIC_CONFLICT',
          message: semanticConflictMessage(verdict.conflicts),
        };
        entry.reason = entry.error.message;
      }
    },
    driver.beforePublish,
    batch.channel,
  );
  return true;
}
