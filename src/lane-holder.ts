// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { sessionClaimSchema } from './hosted-lane.js';
import { isAgentSlug } from './agent-slug.js';
import { HOLDER_REASON_MAX, hostedLaneSchema } from './hosted-lane.js';
export const holderRequestSchema = z
  .object({
    operationId: z.uuid(),
    laneId: z.uuid(),
    authorityEpoch: z.number().int().nonnegative(),
    expected: z
      .object({ head: hostedLaneSchema.shape.head, version: hostedLaneSchema.shape.version })
      .strict()
      .optional(),
    takeover: z.literal(true).optional(),
    acceptHandoff: z.uuid().optional(),
    session: sessionClaimSchema.optional(),
    sessionId: z.string().regex(/^[0-9a-f]{64}$/),
    agent: z.string().refine(isAgentSlug).optional(),
    reason: z.string().trim().min(1).max(HOLDER_REASON_MAX).optional(),
    handoff: z
      .object({
        sessionId: z.string().regex(/^[0-9a-f]{64}$/),
        agent: z.string().refine(isAgentSlug).optional(),
        person: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(value => !(value.handoff && value.acceptHandoff), 'Choose an offer or acceptance, not both.');

/** Stored in the existing operation receipt; an offer does not change the current holder. */
export const holderOfferSchema = z
  .object({
    laneId: z.uuid(),
    from: hostedLaneSchema.shape.holder.unwrap().omit({ change: true }).nullable(),
    to: z
      .object({
        actor: z.string(),
        sessionId: z.string().regex(/^[0-9a-f]{64}$/),
        agent: z.string().refine(isAgentSlug).optional(),
      })
      .strict(),
    reason: z.string().optional(),
    savedHead: hostedLaneSchema.shape.head,
    at: z.number(),
  })
  .strict();
