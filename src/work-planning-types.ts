// SPDX-License-Identifier: Apache-2.0
// Pure planning schemas can be validated in the Convex non-Node runtime.
import { z } from 'zod';
const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
const planningFields = {
  kind: z.enum(['issue', 'initiative']),
  title: z.string().trim().min(1),
  body: z.string().default(''),
  status: z.enum(['proposed', 'open', 'in-progress', 'closed', 'abandoned']).default('open'),
  reason: z.string().optional(),
  intentIds: z.array(id).default([]),
  initiativeId: id.optional(),
};
export const planningItemSchema = z.object({
  id,
  operationId: id,
  request: oid,
  version: z.number().int().positive(),
  previousVersion: z.number().int().nonnegative(),
  ...planningFields,
  at: z.string(),
  provenance: z.literal('user-declared-local'),
});
export const planningCommentSchema = z.object({
  id,
  itemId: id,
  request: oid,
  authorLabel: z.string(),
  text: z.string(),
  at: z.string(),
  provenance: z.literal('user-declared-local'),
});
export const planningPutSchema = z.object({
  action: z.literal('put-planning-item'),
  operationId: id,
  itemId: id,
  expectedVersion: z.number().int().nonnegative().default(0),
  ...planningFields,
});
export const planningCommentCommandSchema = z.object({
  action: z.literal('comment-planning-item'),
  operationId: id,
  itemId: id,
  authorLabel: z.string().trim().default(''),
  text: z.string().min(1),
});
export const planningWriteSchema = z.discriminatedUnion('action', [
  planningPutSchema,
  planningCommentCommandSchema,
]);
export const planningCommandSchema = z.discriminatedUnion('action', [
  planningPutSchema,
  planningCommentCommandSchema,
  z.object({ action: z.literal('export-planning') }),
]);
export type PlanningItem = z.infer<typeof planningItemSchema>;
export type PlanningCommand = z.infer<typeof planningCommandSchema>;
export type PlanningWrite = z.infer<typeof planningWriteSchema>;
