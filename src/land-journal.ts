// SPDX-License-Identifier: Apache-2.0
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkView } from './work-types.js';
export type SingleLandingAttempt = {
  attempt: number;
  viewId?: string;
  previous: string | null;
  timing?: import('./landing-attempt-timing.js').AttemptTiming;
};
export type LandEntry = {
  requestOperationId?: string;
  sourceOperationId?: string;
  sharedOperationId?: string;
  submissionOperationId?: string;
  command: FinishAction;
  inputs: WorkView['inputs'];
  viewId?: string;
  queued?: boolean;
  single?: SingleLandingAttempt;
  singleAttempts?: SingleLandingAttempt[];
  infrastructureRetries?: { code: string; runId: string }[];
  result?: Record<string, unknown>;
};
