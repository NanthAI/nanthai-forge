// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import type { hostedLaneSchema } from '../src/hosted-lane';
import { holderOfferSchema } from '../src/lane-holder';
import { hostedOperationSchema } from '../src/hosted-source-operation';
import { hostedOperationRow } from './projectHostedOperations';
import { invariant } from '../src/errors';
/** Only the current holder's person or project owner can have offered this Lane. Two point reads at most. */
export async function acceptedHandoff(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: z.infer<typeof hostedLaneSchema>,
  projectOwner: string,
  operationId: string,
  actor: string,
  sessionId: string,
) {
  const candidates = [...new Set([lane.holder?.actor ?? lane.actor, projectOwner])];
  const records = await Promise.all(
    candidates.map(person => hostedOperationRow(ctx, projectId, person, operationId)),
  );
  const offers = records.flatMap(row => {
    if (!row) return [];
    const terminal = hostedOperationSchema.parse(JSON.parse(row.value)).terminal;
    if (terminal?.outcome.status !== 'completed') return [];
    const result = terminal.outcome.result;
    const parsed = holderOfferSchema.safeParse(
      result && typeof result === 'object' && !Array.isArray(result) ? result.offer : undefined,
    );
    return parsed.success ? [parsed.data] : [];
  });
  invariant(offers.length === 1, 'BAD_ARGUMENT', 'Select one recorded handoff offer for this Lane.');
  const offer = offers[0]!;
  invariant(
    offer.laneId === lane.id &&
      offer.to.actor === actor &&
      offer.to.sessionId === sessionId &&
      (offer.from?.actor ?? null) === (lane.holder?.actor ?? null) &&
      (offer.from?.sessionId ?? null) === (lane.holder?.sessionId ?? null) &&
      (offer.from?.since ?? null) === (lane.holder?.since ?? null),
    'WORK_STALE',
    'This offer is for another session, or its holder changed. No saved work changed.',
  );
  return offer;
}
