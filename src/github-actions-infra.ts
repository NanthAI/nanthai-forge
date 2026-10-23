// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { ActionsFailure } from './github-actions-api.js';

export const PENDING_ACTIONS_INFRA = 'GITHUB_ACTIONS_PENDING_INFRA';
export type ActionsAttempt = {
  outcome: 'ambiguous' | 'accepted' | 'rejected';
  rejectionClass?: string | undefined;
  startedAt?: string;
  detail?: string;
  retryable?: boolean;
  response?: ActionsFailure;
};
export type ActionsDiscovery = {
  phase: 'push' | 'dispatch';
  observedAt: string;
  matches: number;
};
export type ActionsBranchEvidence = {
  observedAt: string;
  source: 'git' | 'rest';
  commit: string | null;
};
/** A controller observation stopped, but the provider operation has no terminal verdict. */
export function pendingActionsInfra(run: {
  status: string;
  error?: { code: string } | undefined;
  cancelRequested?: boolean | undefined;
}) {
  return run.status === 'interrupted' && run.error?.code === PENDING_ACTIONS_INFRA && !run.cancelRequested;
}
export { gitPushRejectionClass as pushRejectionClass } from './github-sync-classification.js';
export class ActionsPushFailed extends ForgeError {
  constructor(failure: { code: string; message: string }) {
    super(failure.code, failure.message);
  }
}
export function actionsPushFailureMessage(rejectionClass: string) {
  switch (rejectionClass) {
    case 'workflow-scope':
      return 'GitHub rejected the check push: token lacks workflow scope. Authorize workflow scope for the Git credential, then start a new check.';
    case 'ref-policy':
      return 'GitHub rejected the check ref under branch protection or repository rules. Allow the run-owned forge-check/* ref in the target repository, then start a new check.';
    case 'ref-name':
      return 'GitHub rejected the check ref name. Check the target repository ref-name rules, then start a new check.';
    case 'access-rejected':
      return 'GitHub rejected check push access. Check the target repository and Git credential write access, then start a new check.';
    default:
      return 'GitHub rejected the check ref. Inspect the retained redacted push diagnostic and target repository rules, then start a new check.';
  }
}
export class ActionsPushUnknown extends ForgeError {
  readonly state = 'pending-infra';
  constructor() {
    super(
      'GITHUB_ACTIONS_PUSH_UNKNOWN',
      'pending-infra: Actions push outcome unknown; retain the original commit and ref for later discovery. The bounded discovery window resumes from retained observations; any retry uses the identical commit and create-only ref lease.',
    );
  }
}
