// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { ActionsFailure } from './github-actions-api.js';

export const PENDING_ACTIONS_INFRA = 'GITHUB_ACTIONS_PENDING_INFRA';
export type ActionsAttempt = {
  outcome: 'ambiguous' | 'accepted' | 'rejected';
  rejectionClass?: string | undefined;
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
/** Only explicit receive-pack rejections prove this push did not update its ref.
 * Transience alone (EOF, HTTP 5xx, timeout) never proves non-execution. */
export function pushRejectionClass(detail: string): string | undefined {
  if (/! \[(?:remote )?rejected\]/i.test(detail)) return 'ref-rejected';
  if (
    /authentication failed|could not read (?:username|password)|repository not found|permission[^\n]*denied|write access[^\n]*not granted|access denied|not authorized|invalid credentials|bad credentials/i.test(
      detail,
    )
  )
    return 'access-rejected';
  return undefined;
}
export class ActionsPushUnknown extends ForgeError {
  readonly state = 'pending-infra';
  constructor() {
    super(
      'GITHUB_ACTIONS_PUSH_UNKNOWN',
      'pending-infra: Actions push outcome unknown; retain the original commit and ref for later discovery. Empty ref listings do not prove the push did not execute.',
    );
  }
}
