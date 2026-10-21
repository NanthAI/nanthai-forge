// SPDX-License-Identifier: Apache-2.0
import { ActionsApiError, mutate, observe, type ActionsApi, type ActionsRun } from './github-actions-api.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';
import { ForgeError, invariant } from './errors.js';

export const DISPATCH_REJECTED = 'GITHUB_ACTIONS_DISPATCH_REJECTED';
export class ActionsDispatchRejected extends ForgeError {
  constructor(
    readonly httpStatus: number,
    readonly attempts: number,
  ) {
    super(
      DISPATCH_REJECTED,
      `GitHub Actions dispatch rejected (HTTP ${httpStatus}) after ${attempts} attempts; no execution was created.`,
    );
  }
}
const rejected = (journal: ActionsJournal) =>
  new ActionsDispatchRejected(journal.dispatchStatus!, journal.dispatchRejections!);
export class ActionsDispatchUnknown extends ForgeError {
  constructor(readonly httpStatus?: number) {
    super(
      'GITHUB_ACTIONS_UNKNOWN',
      `Actions dispatch outcome ambiguous${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}; retained dispatch must be reconciled.`,
    );
  }
}

// The branch REST index can lag behind a successful Git push. At most 60 s of backoff.
async function visibleBranch(
  plan: ModalPlan,
  journal: ActionsJournal,
  api: ActionsApi,
  progress: (message: string) => void,
) {
  const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
  for (let attempt = 0; ; attempt++) {
    try {
      const branch = await mutate(
        api,
        () =>
          api.request<{ commit: { sha: string } }>(
            `repos/${journal.repo}/branches/${encodeURIComponent(`forge-check/${plan.runId}`)}`,
          ),
        progress,
      );
      invariant(branch.commit?.sha === journal.commit, 'EVIDENCE_CHANGED', 'Actions branch source changed.');
      return;
    } catch (error) {
      if (!(error instanceof ActionsApiError) || error.httpStatus !== 404) throw error;
      if (attempt === delays.length)
        throw new ForgeError(
          'GITHUB_ACTIONS_BRANCH_UNAVAILABLE',
          'Actions branch not visible after waiting (HTTP 404); dispatch was not sent.',
        );
    }
    await api.sleep(delays[attempt]!);
  }
}

export async function ensureActionsDispatch(
  plan: ModalPlan,
  journal: ActionsJournal,
  save: () => void,
  api: ActionsApi,
  cancelled: () => boolean,
  progress: (message: string) => void,
) {
  if (journal.runId) return;
  const branch = `forge-check/${plan.runId}`,
    base = `repos/${journal.repo}/actions`;
  const ambiguous = () => journal.dispatchOutcome === undefined || journal.dispatchOutcome === 'ambiguous';
  const readRuns = () =>
    observe(
      api,
      () =>
        api.pages<ActionsRun>(
          `${base}/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
          'workflow_runs',
        ),
      progress,
    );
  const adopt = (runs: ActionsRun[]) => {
    const matches = runs.filter(run => run.head_sha === journal.commit && run.display_title === branch);
    invariant(matches.length <= 1, 'EVIDENCE_CHANGED', 'Multiple Actions runs match the retained dispatch.');
    if (matches[0]) {
      journal.runId = matches[0].id;
      save();
    }
  };
  const lookup = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      adopt(await readRuns());
      if (journal.runId) return;
      if (attempt < 11) await api.sleep(Math.min(60_000, 5_000 * (attempt + 1)));
    }
  };
  const unknown = () => {
    if (ambiguous()) {
      journal.dispatchLookupExhausted = true;
      save();
    }
    throw new ActionsDispatchUnknown(journal.dispatchStatus);
  };

  let recovery = journal.dispatchRecoveryUsed === true;
  if (journal.dispatching) {
    // Old journals predate outcome tracking and represent an unknown dispatch too.
    const recover =
      ambiguous() &&
      !journal.dispatchRecoveryUsed &&
      (journal.dispatchOutcome === undefined || journal.dispatchLookupExhausted);
    await lookup();
    if (journal.runId) return;
    if (!recover || cancelled()) unknown();
    recovery = true;
  }

  if ((journal.dispatchRejections ?? 0) >= 5) throw rejected(journal);
  let branchVisible = false;
  while (!cancelled()) {
    if (!branchVisible) {
      await visibleBranch(plan, journal, api, progress);
      branchVisible = true;
    }
    if (cancelled()) return;
    if (recovery) {
      // After branch visibility, a fresh, complete query must still be empty.
      const fresh = await readRuns();
      adopt(fresh);
      if (journal.runId) return;
      if (fresh.length) unknown();
      journal.dispatchRecoveryUsed = true;
      progress('No Actions runs found on the retained branch; using the single recovery dispatch.');
    }
    journal.dispatching = true;
    // A crash before recording the response must be treated as ambiguous.
    journal.dispatchOutcome = 'ambiguous';
    journal.dispatchLookupExhausted = false;
    delete journal.dispatchStatus;
    save();
    try {
      await mutate(
        api,
        () =>
          api.request(`${base}/workflows/forge-check.yml/dispatches`, 'POST', {
            ref: branch,
            inputs: { runId: plan.runId, plan: JSON.stringify(plan.groups.map((_, index) => index)) },
          }),
        progress,
      );
      journal.dispatchOutcome = 'accepted';
      save();
      break;
    } catch (error) {
      if (error instanceof ActionsApiError && error.httpStatus !== undefined)
        journal.dispatchStatus = error.httpStatus;
      if (!(error instanceof ActionsApiError) || error.outcome !== 'rejected') {
        save();
        progress(
          `Actions dispatch response ambiguous${journal.dispatchStatus === undefined ? '' : ` (HTTP ${journal.dispatchStatus})`}; looking up the retained run.`,
        );
        break;
      }
      journal.dispatchOutcome = 'rejected';
      journal.dispatching = false;
      journal.dispatchRejections = (journal.dispatchRejections ?? 0) + 1;
      save();
      progress(
        `Actions dispatch rejected (HTTP ${journal.dispatchStatus}); attempt ${journal.dispatchRejections}/5.`,
      );
      if (journal.dispatchRejections >= 5) throw rejected(journal);
      await api.sleep(5_000 * 2 ** (journal.dispatchRejections - 1));
    }
  }
  if (!journal.dispatching) return;
  await lookup();
  if (!journal.runId) unknown();
}
