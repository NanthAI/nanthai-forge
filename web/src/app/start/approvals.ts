// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who approves landings: the one acceptance setting Getting started asks about once and Landing and checks shows. A
// write changes only `acceptance.mode` (the rest of the policy stays as it is), compare-and-swaps on the policy the
// reader saw, and keeps its operation id until the server answers, so a retry after a lost reply records one change.
import { useRef } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import { PendingWrite } from '../../pending-write';

export type ApprovalMode = AutonomyPolicy['acceptance']['mode'];

export const approvalWords: Record<ApprovalMode, { title: string; sub: string }> = {
  review: {
    title: 'Ask me before each landing',
    sub: 'Every checked change waits for a person on Needs me.',
  },
  'auto-on-pass': {
    title: 'Land on its own when the check passes',
    sub: 'Checked work reaches main without waiting for you. Protected paths still wait for a person.',
  },
};

/** The setting command for one answer: only the mode changes. */
export function approvalCommand(operationId: string, expected: AutonomyPolicy, mode: ApprovalMode) {
  return { action: 'set-policy' as const, operationId, expectedPolicy: expected, acceptance: { mode } };
}

export function useApprovalWrite(projectId: Id<'hostedProjects'>) {
  const client = useConvex();
  const write = useRef<PendingWrite<{ expected: AutonomyPolicy; mode: ApprovalMode }, AutonomyPolicy> | null>(
    null,
  );
  write.current ??= new PendingWrite(async ({ operationId, command }) => {
    const reply = await client.mutation(api.projectAutonomy.set, {
      projectId,
      command: JSON.stringify(approvalCommand(operationId, command.expected, command.mode)),
    });
    return reply.policy as AutonomyPolicy;
  });
  return (expected: AutonomyPolicy, mode: ApprovalMode) => write.current!.send({ expected, mode });
}
