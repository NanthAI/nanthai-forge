// SPDX-License-Identifier: Apache-2.0
// Shared Intent metadata is also validated in the Convex non-Node runtime.
import { z } from 'zod';
import { planningPutSchema, planningCommentCommandSchema } from './work-planning-types.js';
const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
export const channelBaseSchema = z.object({ name: z.string().trim().min(1), head: oid, acceptanceId: id });
export const intentCreateSchema = z.object({
  action: z.literal('intent'),
  outcome: z.string().trim().min(1).max(500),
  constraints: z.string().max(4000).default(''),
  baseChannel: channelBaseSchema.optional(),
});
export const sourceAnchorSchema = z.object({
  viewId: id,
  base: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.string().min(1),
  side: z.enum(['before', 'after']),
  line: z.number().safe().positive(),
  blob: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SourceAnchor = z.infer<typeof sourceAnchorSchema>;
export const intentNoteSchema = z.object({
  action: z.literal('note'),
  intentId: id,
  text: z.string().trim().min(1).max(4000),
  kind: z.enum(['comment', 'decision']),
  anchor: sourceAnchorSchema.optional(),
});
export const intentStatusSchema = z.object({
  action: z.literal('intent-status'),
  intentId: id,
  status: z.enum(['active', 'ready', 'abandoned', 'completed']),
});
export const intentMetadataCommandSchema = z.discriminatedUnion('action', [
  intentCreateSchema.extend({ base: oid, hostedBase: channelBaseSchema.optional() }),
  intentNoteSchema,
  intentStatusSchema,
]);
export const metadataCommandSchema = z.union([
  intentMetadataCommandSchema,
  planningPutSchema,
  planningCommentCommandSchema,
]);
export type IntentMetadataCommand = z.infer<typeof intentMetadataCommandSchema>;
export type MetadataCommand = z.infer<typeof metadataCommandSchema>;
