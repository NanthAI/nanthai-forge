// SPDX-License-Identifier: Apache-2.0
// The owner's decision on a held landing, wherever it is drawn (Needs me and the Lane page; Item 48049998).
// A standalone Lane request goes through projectHostedApprovals:decide. A held landing is decided
// on its exact attempt with the calls the /approve page makes: projectHostedAcceptance:approve
// and projectHostedOwnerReview:decline. No new authority: the server checks the owner person on every call.
import { useRef } from 'react';
import { useMutation } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export type HeldAttempt = { submissionId: string; attemptId: string };
/** What one decision goes through: the request's Lane head, or the held landing's exact attempt. */
export type DecideTarget = { head: string } | { landing: HeldAttempt };
export type Decide = (
  input: { decision: 'grant' | 'decline' } & (
    | { laneId: string; head: string }
    | { laneId?: string; landing: HeldAttempt }
  ),
) => Promise<string>;

/** A held row's decision target, or null when nothing on it is the owner's to decide. */
export function decideTarget(row: {
  approval: { needsOwner: boolean; head: string } | null;
  landing: HeldAttempt | null;
}): DecideTarget | null {
  if (row.landing) return { landing: row.landing };
  return row.approval?.needsOwner ? { head: row.approval.head } : null;
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

/** Every call is retry-safe by its own operation id (decline, a request) or its exact attempt (approve). A retry of the
 * same decision after a lost reply keeps its operation id, so it is one decision, as the /approve page did (Item
 * 0a99ab23); a reply, even a refusal, ends that attempt. */
export function useProjectDecide(projectId: Id<'hostedProjects'>): Decide {
  const lane = useMutation(api.projectHostedApprovals.decide);
  const approve = useMutation(approveLanding);
  const decline = useMutation(declineLanding);
  const pending = useRef(new Map<string, string>());
  return async input => {
    const key = JSON.stringify(input);
    const operationId = pending.current.get(key) ?? crypto.randomUUID();
    pending.current.set(key, operationId);
    const selection = 'landing' in input ? { projectId, ...input.landing } : null;
    const reply = await ('head' in input
      ? lane({
          projectId,
          laneId: input.laneId,
          head: input.head,
          decision: input.decision,
          operationId,
        })
      : input.decision === 'grant'
        ? approve(selection!)
        : decline({ ...selection!, operationId }));
    pending.current.delete(key);
    return reply;
  };
}
