// SPDX-License-Identifier: Apache-2.0
import {
  ActionsApiError,
  actionsFailureText,
  mutate,
  observe,
  type ActionsApi,
  type ActionsRun,
  type ActionsFailure,
} from './github-actions-api.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';
import type { ActionsAttempt } from './github-actions-infra.js';
import { ForgeError, invariant } from './errors.js';

export const DISPATCH_REJECTED = 'GITHUB_ACTIONS_DISPATCH_REJECTED';
export class ActionsDispatchRejected extends ForgeError {
  constructor(
    readonly httpStatus: number,
    readonly attempts: number,
    readonly response?: ActionsFailure,
  ) {
    super(
      DISPATCH_REJECTED,
      `GitHub Actions dispatch rejected (HTTP ${httpStatus}) after ${attempts} attempts; no execution was created.${actionsFailureText(response)}`,
    );
  }
}
const rejected = (journal: ActionsJournal) =>
  new ActionsDispatchRejected(journal.dispatchStatus!, journal.dispatchRejections!, journal.dispatchError);
export class ActionsDispatchUnknown extends ForgeError {
  readonly state = 'pending-infra';
  constructor(
    readonly httpStatus?: number,
    readonly response?: ActionsFailure,
  ) {
    super(
      'GITHUB_ACTIONS_UNKNOWN',
      `pending-infra: Actions dispatch outcome unresolved${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}; retained dispatch must be reconciled.${actionsFailureText(response)}`,
    );
  }
}

// The branch REST index can lag behind a successful Git push. At most 60 s of backoff.
async function visibleBranch(
  plan: ModalPlan,
  journal: ActionsJournal,
  api: ActionsApi,
  progress: (message: string) => void,
  save: () => void,
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
      (journal.branchEvidence ??= []).push({
        source: 'rest',
        observedAt: new Date().toISOString(),
        commit: branch.commit?.sha ?? null,
      });
      save();
      invariant(branch.commit?.sha === journal.commit, 'EVIDENCE_CHANGED', 'Actions branch source changed.');
      return;
    } catch (error) {
      if (!(error instanceof ActionsApiError) || error.httpStatus !== 404) throw error;
      (journal.branchEvidence ??= []).push({
        source: 'rest',
        observedAt: new Date().toISOString(),
        commit: null,
      });
      save();
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
  executionAllowed = true,
) {
  if (journal.runId) return;
  const branch = `forge-check/${plan.runId}`,
    base = `repos/${journal.repo}/actions`;
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
      (journal.discovery ??= []).push({
        phase: 'dispatch',
        observedAt: new Date().toISOString(),
        matches: 1,
      });
      journal.runId = matches[0].id;
      save();
    }
  };
  const lookup = async () => {
    // The window bounds this observation only; zero matches never authorizes another POST.
    const short = journal.dispatchOutcome === 'ambiguous' && journal.dispatchStatus === 400;
    const polls = short ? 13 : 12;
    for (let attempt = 0; attempt < polls; attempt++) {
      adopt(await readRuns());
      if (journal.runId) return;
      if (attempt < polls - 1) await api.sleep(short ? 10_000 : Math.min(60_000, 5_000 * (attempt + 1)));
    }
  };
  const unknown = () => {
    journal.dispatchLookupExhausted = true;
    (journal.discovery ??= []).push({ phase: 'dispatch', observedAt: new Date().toISOString(), matches: 0 });
    save();
    progress(
      'pending-infra: no matching run visible yet; later discovery will adopt the original execution. No dispatch repeated.',
    );
    throw new ActionsDispatchUnknown(journal.dispatchStatus, journal.dispatchError);
  };

  const definitiveRejection =
    journal.dispatchOutcome === 'rejected' &&
    [404, 422].includes(journal.dispatchStatus ?? 0) &&
    !journal.dispatchRecoveryUsed;
  if (journal.dispatching || (journal.dispatchOutcome && !definitiveRejection)) {
    // Includes old journals and the historical recovery allowance. Their POST may have run.
    journal.dispatching = true;
    if (journal.dispatchOutcome === 'rejected') journal.dispatchOutcome = 'ambiguous';
    save();
    await lookup();
    if (journal.runId) return;
    unknown();
  }

  invariant(executionAllowed, 'UNSUPPORTED_NODE', 'Retained Actions runtime cannot start a new execution.');
  if ((journal.dispatchRejections ?? 0) >= 5) throw rejected(journal);
  while (!cancelled()) {
    // Revalidate visibility even after a definitive 404/422 rejection.
    await visibleBranch(plan, journal, api, progress, save);
    if (cancelled()) return;
    const attempt: ActionsAttempt = { outcome: 'ambiguous' };
    (journal.dispatchAttempts ??= []).push(attempt);
    journal.dispatching = true;
    // A crash before recording the response must be treated as ambiguous.
    journal.dispatchOutcome = 'ambiguous';
    journal.dispatchLookupExhausted = false;
    delete journal.dispatchStatus;
    delete journal.dispatchError;
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
      attempt.outcome = journal.dispatchOutcome = 'accepted';
      save();
      break;
    } catch (error) {
      if (error instanceof ActionsApiError) {
        attempt.response = journal.dispatchError = error.response;
        if (error.httpStatus !== undefined) journal.dispatchStatus = error.httpStatus;
      }
      if (!(error instanceof ActionsApiError) || error.outcome !== 'rejected') {
        save();
        progress(
          `Actions dispatch response ambiguous${journal.dispatchStatus === undefined ? '' : ` (HTTP ${journal.dispatchStatus})`}; looking up the retained run.${actionsFailureText(journal.dispatchError)}`,
        );
        break;
      }
      attempt.outcome = journal.dispatchOutcome = 'rejected';
      attempt.rejectionClass = error.rejectionClass;
      journal.dispatching = false;
      journal.dispatchRejections = (journal.dispatchRejections ?? 0) + 1;
      save();
      progress(
        `Actions dispatch rejected (HTTP ${journal.dispatchStatus}); attempt ${journal.dispatchRejections}/5.${actionsFailureText(journal.dispatchError)}`,
      );
      if (journal.dispatchRejections >= 5) throw rejected(journal);
      await api.sleep(5_000 * 2 ** (journal.dispatchRejections - 1));
    }
  }
  if (!journal.dispatching) return;
  await lookup();
  if (journal.runId) return;
  unknown();
}
