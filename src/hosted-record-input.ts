// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { decideInputSchema, decisionsInputSchema, decisionRecordSchema } from './decision-types.js';
import { frictionInputSchema, frictionEventSchema } from './friction-types.js';
import { conversationSchema } from './agent-edit-types.js';
export const hostedPeerAckSchema = z.object({
  operationId: z.uuid().optional(),
  laneId: z.uuid(),
  noticeId: z.string().regex(/^[a-f0-9]{64}$/),
  choice: z.enum(['accept-order', 'swap', 'split']),
  text: z.string().optional(),
  conversation: conversationSchema.optional(),
});
export const hostedAckBatchSchema = z.object({
  operationId: z.uuid(),
  answers: z
    .array(hostedPeerAckSchema.extend({ operationId: z.uuid() }))
    .min(1)
    .max(100),
});
export const hostedRecordCommands = {
  friction: frictionInputSchema.omit({ operationId: true }).strict(),
  decide: decideInputSchema.omit({ operationId: true }).strict(),
  decisions: decisionsInputSchema.extend({ cursor: z.string().nullable().default(null) }).strict(),
  'peer-ack': hostedPeerAckSchema.omit({ operationId: true }).strict(),
  'overlap-acks': hostedAckBatchSchema.omit({ operationId: true }).strict(),
};
export const hostedImportPageSchema = z
  .object({
    friction: z.array(frictionEventSchema).max(100).default([]),
    decisions: z.array(decisionRecordSchema).max(100).default([]),
  })
  .refine(page => page.friction.length + page.decisions.length <= 100);
