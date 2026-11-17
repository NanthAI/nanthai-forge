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
/** The planning model fields (src/planning-model.ts, Item d3357f40). Optional and absent on every older record, so
 * old operations replay byte-identically; servers advertise `planning-model` once they store them. */
/** Hand-order ranks (src/planning-model.ts rankBetween): 1 to 64 letters and digits, never ending in "0". Kept here,
 * not imported, so the CLI loads no extra module; tests/planning-model.test.mjs ties both copies. */
export const rankPattern = /^[0-9A-Za-z]{0,63}[1-9A-Za-z]$/;
export const relationKinds = ['depends-on', 'duplicate-of', 'related'] as const;
const rank = z.string().regex(rankPattern, 'order: a rank from rankBetween (1 to 64 letters and digits).');
const label = z.string().trim().min(1).max(32);
const owner = z.string().trim().min(1).max(200);
const relations = z.array(z.object({ kind: z.enum(relationKinds), id })).max(20);
const modelFields = {
  /** Hand order among siblings; absent = creation order (legacyRank). */
  order: rank.optional(),
  /** One type label: idea, task, bug or a project's own. */
  type: label.optional(),
  /** Parent Item: this is a sub-item. */
  parentId: id.optional(),
  /** Who has the Item before a Lane: a Forge handle or handle/agent slug. */
  owner: owner.optional(),
  relations: relations.optional(),
  /** Hidden from public reads of a public plan (with its sub-items, or an Initiative's Items). Stored only when true. */
  hidden: z.literal(true).optional(),
};
/** Model fields of a put: omitted keeps, null (relations [], hidden false) clears. */
const modelPutFields = {
  order: rank.nullable().optional(),
  type: label.nullable().optional(),
  parentId: id.nullable().optional(),
  owner: owner.nullable().optional(),
  relations: relations.optional(),
  hidden: z.boolean().optional(),
};
/** Agents name the model fields in one `fields` object (one MCP listing token); the CLI flattens it into the
 * stored command, so the wire and journal keep one flat shape. */
export const planningPutAgentFields = z.object(modelPutFields).strict();
/**
 * A put names only what it changes. An omitted field keeps the stored value (kind and title are
 * required only to create); clearing needs an explicit empty value: body "", intentIds [],
 * initiativeId null. `reason` describes one version and is never carried over.
 */
const planningPutFields = {
  kind: planningFields.kind.optional(),
  title: planningFields.title.optional(),
  body: z.string().optional(),
  status: z.enum(['proposed', 'open', 'in-progress', 'closed', 'abandoned']).optional(),
  reason: planningFields.reason,
  intentIds: z.array(id).optional(),
  initiativeId: id.nullable().optional(),
  ...modelPutFields,
};
/** Fields a server without `planning-model` drops; the CLI refuses to send them there. */
export const planningModelPutKeys = ['order', 'type', 'parentId', 'owner', 'relations', 'hidden'] as const;
export const planningItemSchema = z.object({
  id,
  operationId: id,
  request: oid,
  version: z.number().int().positive(),
  previousVersion: z.number().int().nonnegative(),
  ...planningFields,
  ...modelFields,
  /** The account that last wrote this body, recorded by the hosted journal replay (S-17). Public reads
   * map it to a Forge handle (convex/publicPeople.ts); absent on local Work and on older rows. */
  author: z.string().min(1).max(200).optional(),
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
  ...planningPutFields,
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
