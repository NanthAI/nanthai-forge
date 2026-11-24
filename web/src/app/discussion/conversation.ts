// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../../convex/_generated/api';
import { convexErrorData } from '../../../../src/errors';
import { errorCode } from '../session';

export type ThreadPage = FunctionReturnType<typeof api.projectDiscussionThread.read>;
export type ThreadEntry = ThreadPage['entries'][number];
export type Answer = (entry: { id: string }, choice: string, reason?: string) => Promise<void>;
export type DismissAsk = (entry: { id: string }) => Promise<void>;

const ANSWER_ERRORS: Record<string, string> = {
  WORK_STALE: 'The recipient session has ended, so this question can no longer be answered.',
  WORK_OPERATION_CHANGED:
    'This question already has a recorded answer. Refresh or open the thread to see it.',
  BAD_ARGUMENT:
    'Forge could not accept this choice here. Open the thread to check who can answer and which choices are available.',
  PROJECT_UNAVAILABLE: 'You do not have write access to answer questions in this project.',
  ACCOUNT_SUSPENDED: 'Your account is suspended and cannot record answers.',
  AUTH_SCOPE_DENIED: 'This session does not have permission to answer this question.',
  HOSTED_CONFLICT: 'The thread changed while saving your answer. Click the choice again to retry.',
  HOSTED_ACTION_FAILED: 'Forge could not confirm the answer. Click the choice again to retry.',
  HOSTED_REQUEST_FAILED: 'Forge could not confirm the answer. Click the choice again to retry.',
};

/** Map a refused coordination ack's structured error code to plain words (never raw server wording). */
export function answerFailureReason(error: unknown): string {
  const raw = convexErrorData(error)?.code;
  const code = errorCode(error) ?? (typeof raw === 'string' ? raw : undefined);
  if (code)
    return Object.hasOwn(ANSWER_ERRORS, code)
      ? ANSWER_ERRORS[code]!
      : 'Forge refused the answer. Open the thread to check the question.';
  return 'Could not reach Forge to confirm the answer. Check your connection and try again.';
}
