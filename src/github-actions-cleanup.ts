// SPDX-License-Identifier: Apache-2.0
import { pendingActionsInfra } from './github-actions-infra.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ActionsApi, type ActionsRun, observe } from './github-actions-api.js';
import { actionsJournal, deleteActionsRef, type ActionsJournal } from './github-actions-export.js';
import { durableReplace } from './native-durability.js';
import { validateRemoteCheckPlan, type RemoteCheckPlan } from './remote-check-plan.js';
import { receiptSchema } from './work-run-receipt.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

const terminal = (status: string) => !['queued', 'preparing', 'running'].includes(status);
/** A rotating, bounded local-history sweep. Unknown dispatches and live operations keep their refs. */
export async function sweepActionsRefs(
  store: WorkStore,
  repo: string,
  api: ActionsApi,
  progress: (message: string) => void,
  deleteRef = deleteActionsRef,
) {
  const cursorPath = join(store.directory, 'github-actions-cleanup-cursor.json');
  try {
    let offset = 0;
    try {
      const saved = JSON.parse(readFileSync(cursorPath, 'utf8')) as { offset?: number };
      if (Number.isSafeInteger(saved.offset) && saved.offset! >= 0) offset = saved.offset!;
    } catch {
      /* A missing disposable cursor starts at the first local run. */
    }
    const page = store.page('runs', offset, 20);
    let visited = 0,
      attempted = 0;
    for (const raw of page.records) {
      if (attempted >= 5) break;
      visited++;
      const run = raw as CheckRun;
      if (!terminal(run.status) || run.backend?.actual !== 'github-actions' || !run.backend.pin) continue;
      const path = join(store.directory, `check-${run.id}`);
      try {
        const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(path, 'result.json'), 'utf8')));
        if (
          receipt.status !== run.status ||
          receipt.backend?.pin !== run.backend.pin ||
          pendingActionsInfra(receipt)
        )
          continue;
        const plan = JSON.parse(readFileSync(join(path, 'modal-plan.json'), 'utf8')) as RemoteCheckPlan;
        validateRemoteCheckPlan(plan, run);
        const { journal, save } = actionsJournal(path, plan, repo, 'ubuntu-latest');
        if (journal.repo !== repo || journal.deleted || !journal.pushed || !journal.commit) continue;
        if (journal.runId) {
          attempted++;
          const remote = await observe(
            api,
            () => api.request<ActionsRun>(`repos/${repo}/actions/runs/${journal.runId}`),
            progress,
          );
          if (
            remote.id !== journal.runId ||
            remote.head_sha !== journal.commit ||
            remote.display_title !== `forge-check/${plan.runId}` ||
            remote.status !== 'completed'
          )
            continue;
        } else if (
          journal.dispatchOutcome !== 'rejected' ||
          journal.dispatching ||
          journal.dispatchRecoveryUsed
        ) {
          continue;
        } else attempted++;
        // Re-read local state after network observation: a reopened operation must keep its branch.
        const current = store.select('runs', run.id);
        if (!current || !terminal(current.status) || current.backend?.pin !== journal.pin) continue;
        await deleteRef(plan, journal, save, undefined, ms => api.sleep(ms), progress);
        progress(`Removed stale run-owned ref forge-check/${run.id}; source and result remain retained.`);
      } catch {
        progress(
          `Stale check ref ${run.id} retained; cleanup could not establish matching terminal evidence.`,
        );
      }
    }
    const next = offset + visited;
    durableReplace(cursorPath, JSON.stringify({ offset: next >= page.total ? 0 : next }));
  } catch {
    progress('Check-ref sweep deferred; recorded results are unchanged.');
  }
}

/** Results/logs are durable before this is called; an unresolved remote run keeps its branch. */
export async function cleanupActionsResult(
  plan: RemoteCheckPlan,
  journal: ActionsJournal,
  save: () => void,
  api: ActionsApi,
  progress: (message: string) => void,
  deleteRef = deleteActionsRef,
) {
  if (!journal.terminal || !journal.pushed || journal.deleted) return;
  try {
    await deleteRef(plan, journal, save, undefined, ms => api.sleep(ms), progress);
    progress('Removed run-owned ref after recording result.');
  } catch {
    progress('Result recorded; run-owned ref cleanup requires reconciliation.');
  }
}
