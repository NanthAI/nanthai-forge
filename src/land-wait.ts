import { currentChannelHead } from './agent-defaults.js';
import type { LandEntry } from './land-journal.js';
// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { workProgress } from './work-progress.js';
import { diagnosticCause } from './landing-observation.js';
import { strandedActionsRun } from './github-actions-recovery.js';
import { batchEdit } from './landing-batch-store.js';
import { changedLandingEnvironment, changedLandingRuntime } from './landing-environment.js';
import { checkEnvironment } from './check-environment.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkService } from './work.js';
import type { landReceipt } from './land-receipt.js';

/** Infrastructure recovery keeps the entry and original input pins. Ambiguous
 * Actions dispatches reconcile the SAME run; they never enqueue another check. */
export async function recoverLandInfrastructure(work: WorkService, ids: string[]) {
  const store = work.store;
  let recovered = false;
  for (const id of ids) {
    const entry = store.select('landingEntries', id);
    if (entry?.status !== 'interrupted' || !entry.runId) continue;
    const run = store.select('runs', entry.runId);
    if (!run || run.cancelRequested) continue;
    if (strandedActionsRun(store, run)) {
      await retryWorkPhase(id, () =>
        work.dispatch(
          {
            action: 'run-check',
            operationId: run.id,
            viewId: run.viewId,
            expectedHead: run.head,
            checkId: run.check.id,
            expectedDefinition: run.check.definition,
            expectedEnvironment: run.environment.fingerprint,
            ...(run.interaction ? { interaction: run.interaction } : {}),
          },
          store.revision(),
        ),
      );
      recovered = true;
      continue;
    }
    const cause = diagnosticCause(run);
    if (cause !== 'infra' || run.status !== 'interrupted') continue;
    // Only interrupted execution is retryable; unavailable runners and budget
    // decisions remain explicit terminal outcomes.
    const code = run.error?.code ?? run.status;
    await batchEdit(work, id, data => {
      const current = data.landingEntries!.find(item => item.id === id)!;
      const check = data.checks.find(check => check.id === current.checkId);
      if (
        current.status !== 'interrupted' ||
        check?.definition !== current.definition ||
        !current.environmentSnapshot ||
        !current.runtimeSnapshot ||
        changedLandingEnvironment(current.environmentSnapshot, checkEnvironment(), check).length ||
        changedLandingRuntime(current.runtimeSnapshot).length
      )
        return;
      (current.infrastructureRetries ??= []).push({ at: new Date().toISOString(), code, runId: run.id });
      current.status = 'queued';
      delete current.batchId;
      delete current.runId;
      delete current.terminalAt;
      delete current.reason;
      recovered = true;
    });
  }
  return recovered;
}

export async function waitForLand(
  work: WorkService,
  drive: () => ReturnType<typeof landReceipt> | Promise<ReturnType<typeof landReceipt>>,
) {
  for (;;) {
    let response: ReturnType<typeof landReceipt>;
    try {
      response = await drive();
    } catch (error) {
      if (
        !(error instanceof ForgeError) ||
        !['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'].includes(error.code)
      )
        throw error;
      workProgress('waiting for land', `${error.code}: replaying the retained request`);
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    const result = response.result;
    if (
      await recoverLandInfrastructure(
        work,
        result.entries.map(entry => entry.operationId),
      )
    )
      continue;
    if (result.terminal) return response;
    workProgress('waiting for land', result.summary.join('; '));
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** The ordinary exact-check path uses the same failure classification. */
export function retrySingleInfrastructure(work: WorkService, entry: LandEntry) {
  if (!entry.single || typeof entry.result?.runId !== 'string') return;
  const run = work.store.select('runs', entry.result.runId);
  if (!run || run.cancelRequested || diagnosticCause(run) !== 'infra' || run.status !== 'interrupted') return;
  const code = run.error?.code ?? run.status;
  if (
    work.store.select('checks', run.check.id)?.definition !== run.check.definition ||
    run.environment.fingerprint !== checkEnvironment().fingerprint
  )
    return;
  (entry.infrastructureRetries ??= []).push({ code, runId: run.id });
  entry.single = {
    attempt: entry.single.attempt + 1,
    previous: currentChannelHead(work.store, entry.command.accept!.channel),
  };
  entry.result = { status: 'waiting', message: `Retrying infrastructure interruption ${code}` };
}
