// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The two answers on a taken-out-of-main card (J08). "Bring it back" is `start --reopen`'s server path, not a second
// one: read the Lane's pins (projectHostedLanes:select), then reopen it with the lifecycle mutation the CLI sends
// (projectHostedLifecycle:transition); the Lane returns at its saved head. "Leave it out" only marks the project's
// notice so the card goes for this reader. Both run on a click; nothing here reads or polls while a page is open.
import { useConvex } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { useMemo } from 'react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { convexErrorData } from '../../../../src/errors';

export type TakenTarget = { laneId: string; intentId: string };
export type TakenAnswer = { ok: true } | { ok: false; reason: string };
export type TakenActions = {
  bringBack: (target: TakenTarget) => Promise<TakenAnswer>;
  leaveOut: (intentId: string) => Promise<TakenAnswer>;
};

type LaneRead = { projectId: Id<'hostedProjects'>; laneId: string };
const select = makeFunctionReference<'query', LaneRead, string>('projectHostedLanes:select');
const transition = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; request: string },
  string
>('projectHostedLifecycle:transition');
const resolve = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; intentId: string; action: 'left' | 'back' },
  null
>('projectHostedRevertNotice:resolveTaken');

const REFUSED: Record<string, string> = {
  WORK_STALE: 'It changed meanwhile. Open the Lane to see where it stands.',
  PROJECT_UNAVAILABLE: 'Only the Lane’s owner or the project owner can bring it back.',
};
/** Words for a refusal; a failure with no Forge code means the call never arrived, so nothing changed. */
export function takenFailure(error: unknown, did: string): TakenAnswer {
  const code = convexErrorData(error)?.code;
  return {
    ok: false,
    reason:
      typeof code === 'string' && REFUSED[code]
        ? REFUSED[code]
        : `Could not ${did}. Nothing changed; try again.`,
  };
}

type LanePins = {
  head: string;
  version: number;
  sourceVersion: number;
  lifecycleVersion: number;
  authority: { epoch: number };
};
/** The lifecycle request the CLI's `reopen` sends for a Lane, pinned to the Lane as the server has it now. */
export const reopenRequest = (laneId: string, lane: LanePins, operationId = crypto.randomUUID()) => ({
  operationId,
  authorityEpoch: lane.authority.epoch,
  action: 'reopen',
  reason: '',
  target: {
    kind: 'lane',
    laneId,
    expected: {
      head: lane.head,
      version: lane.version,
      sourceVersion: lane.sourceVersion,
      lifecycleVersion: lane.lifecycleVersion,
    },
    dirty: false,
    saveOperationId: null,
  },
});

export function useTakenActions(projectId: Id<'hostedProjects'>): TakenActions {
  const convex = useConvex();
  return useMemo(
    () => ({
      async bringBack({ laneId, intentId }) {
        try {
          const lane = JSON.parse(await convex.query(select, { projectId, laneId })) as LanePins;
          const reply = JSON.parse(
            await convex.mutation(transition, {
              projectId,
              request: JSON.stringify(reopenRequest(laneId, lane)),
            }),
          ) as { status?: string };
          if (reply.status === 'stale' || reply.status === 'failed')
            return takenFailure({ data: { code: 'WORK_STALE' }, name: 'ConvexError' }, 'bring it back');
          // The Lane is open again; the card has done its job for everyone. A failed mark leaves the card, harmlessly.
          await convex.mutation(resolve, { projectId, intentId, action: 'back' }).catch(() => null);
          return { ok: true };
        } catch (error) {
          return takenFailure(error, 'bring it back');
        }
      },
      async leaveOut(intentId) {
        try {
          await convex.mutation(resolve, { projectId, intentId, action: 'left' });
          return { ok: true };
        } catch (error) {
          return takenFailure(error, 'leave it out');
        }
      },
    }),
    [convex, projectId],
  );
}
