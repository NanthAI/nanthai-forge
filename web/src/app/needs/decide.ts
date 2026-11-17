// SPDX-License-Identifier: Apache-2.0
// The owner's decision on a held landing, wherever it is drawn (Needs me and the Lane page; Item 48049998). A Lane's
// approval request is decided through it (projectHostedApprovals:decide; a grant there also approves its held
// landing). A landing held by the landing policy itself (protected paths, a supervised project) has no request, so
// it is decided on its exact held attempt with the calls the /approve page makes: projectHostedAcceptance:approve
// and projectHostedOwnerReview:decline. No new authority: the server checks the owner person on every call.
import { useMutation } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export type HeldAttempt = { submissionId: string; attemptId: string };
/** What one decision goes through: the request's Lane head, or the held landing's exact attempt. */
export type DecideTarget = { head: string } | { landing: HeldAttempt };
export type Decide = (
  input: { laneId: string; decision: 'grant' | 'decline' } & DecideTarget,
) => Promise<string>;

/** A held row's decision target, or null when nothing on it is the owner's to decide. */
export function decideTarget(row: {
  approval: { needsOwner: boolean; head: string } | null;
  landing: HeldAttempt | null;
}): DecideTarget | null {
  if (row.approval?.needsOwner) return { head: row.approval.head };
  return row.landing ? { landing: row.landing } : null;
}

type Selection = { projectId: Id<'hostedProjects'> } & HeldAttempt;
const approveLanding = makeFunctionReference<'mutation', Selection, string>(
  'projectHostedAcceptance:approve',
);
const declineLanding = makeFunctionReference<
  'mutation',
  Selection & { operationId: string; reason?: string },
  string
>('projectHostedOwnerReview:decline');

/** Every call is retry-safe by its own operation id (decline) or its exact attempt (approve). */
export function useProjectDecide(projectId: Id<'hostedProjects'>): Decide {
  const lane = useMutation(api.projectHostedApprovals.decide);
  const approve = useMutation(approveLanding);
  const decline = useMutation(declineLanding);
  return input => {
    const operationId = crypto.randomUUID();
    if ('head' in input)
      return lane({
        projectId,
        laneId: input.laneId,
        head: input.head,
        decision: input.decision,
        operationId,
      });
    const selection = { projectId, ...input.landing };
    return input.decision === 'grant' ? approve(selection) : decline({ ...selection, operationId });
  };
}
