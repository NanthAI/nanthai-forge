// SPDX-License-Identifier: Apache-2.0
// Pure planning schemas can be validated in the Convex non-Node runtime.
import { z } from 'zod';
import { AGENT_CLIENT } from './agent-slug.js';
const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
const agentSlugShape = /^[a-z]{2,10}-[a-z]{2,10}$/;
/** Stored status words (Item 4c9e961e adds the two shelves). Archived and Deleted Items are out of every view, count
 * and agent list unless asked for by status; their version records the status they left in `was`. */
const unshelvedStatuses = ['proposed', 'open', 'in-progress', 'closed', 'abandoned'] as const;
const shelfStatuses = ['archived', 'deleted'] as const;
const planningStatuses = [...unshelvedStatuses, ...shelfStatuses] as const;
export const isShelved = (status: string) => status === 'archived' || status === 'deleted';
const planningFields = {
  kind: z.enum(['issue', 'initiative']),
  title: z.string().trim().min(1),
  body: z.string().default(''),
  status: z.enum(planningStatuses).default('open'),
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
/** Original backlog facts are attribution, never Forge acceptance evidence. Reader expansion precedes the importer. */
const planningImportSchema = z.object({
  source: z.string().trim().min(1),
  key: z.string().trim().min(1),
  createdAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  closedAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  originalHandle: z
    .string()
    .regex(/^@?[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\/[a-z0-9-]+)?$/i)
    .optional(),
  batchId: id,
});
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
  imported: planningImportSchema.optional(),
  /** On an Archived or Deleted version only: the status it left, which Unarchive and Restore put back. Set by the
   * reducer, never sent by a client. */
  was: z.enum(unshelvedStatuses).optional(),
};
/** Model fields of a put: omitted keeps, null (relations [], hidden false) clears. */
const modelPutFields = {
  order: rank.nullable().optional(),
  type: label.nullable().optional(),
  parentId: id.nullable().optional(),
  owner: owner.nullable().optional(),
  relations: relations.optional(),
  hidden: z.boolean().optional(),
  imported: planningImportSchema.nullable().optional(),
};
/** Agents name the model fields in one `fields` object (one MCP listing token); the CLI flattens it into the
 * stored command, so the wire and journal keep one flat shape. */
export const planningPutAgentFields = z
  .object({ ...modelPutFields, imported: z.unknown().optional() })
  .strict();
/**
 * A put names only what it changes. An omitted field keeps the stored value (kind and title are
 * required only to create); clearing needs an explicit empty value: body "", intentIds [],
 * initiativeId null. `reason` describes one version and is never carried over.
 */
const planningPutFields = {
  kind: planningFields.kind.optional(),
  title: planningFields.title.optional(),
  body: z.string().optional(),
  status: z.enum(planningStatuses).optional(),
  reason: planningFields.reason,
  intentIds: z.array(id).optional(),
  initiativeId: id.nullable().optional(),
  ...modelPutFields,
};
/** Fields a server without `planning-model` drops; the CLI refuses to send them there. */
export const planningModelPutKeys = [
  'order',
  'type',
  'parentId',
  'owner',
  'relations',
  'hidden',
  'imported',
] as const;
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
/** Discussion fields (Item 9a3d6f5f), all optional so older rows and readers stay valid. `author` is the account the
 * hosted replay observed (public reads map it to a Forge handle); `agent` is the writing agent session's slug from the
 * fixed lists, so it can name no person; `replyTo` is the root comment of its thread; `decision` marks a comment whose
 * text was also written into the Item body's Decisions section. */
const discussionFields = {
  author: z.string().min(1).max(200).optional(),
  agent: z.string().regex(agentSlugShape).optional(),
  /** The writing agent session's client as its launcher declared it, `tool` or `tool:model` (receipts' agentClient,
   * 81d12a32); declared, never verified, and only beside `agent`. */
  agentClient: z.string().regex(AGENT_CLIENT).optional(),
  replyTo: id.optional(),
  decision: z.literal(true).optional(),
};
export const planningCommentSchema = z.object({
  id,
  itemId: id,
  request: oid,
  authorLabel: z.string(),
  text: z.string(),
  at: z.string(),
  provenance: z.literal('user-declared-local'),
  ...discussionFields,
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
  /** Reply in the thread of this comment (a reply to a reply joins the same thread). */
  replyTo: id.optional(),
  /** Also write the text into the Item body's Decisions section, with the date and the author label. */
  decision: z.boolean().optional(),
  /** The writing agent session's slug; anything outside the fixed lists is dropped by the reducer. */
  agent: z.string().max(40).optional(),
  /** The writing agent session's declared client and model (`tool:model`); dropped without `agent` or off-shape. */
  agentClient: z.string().max(100).optional(),
  /** Set by the hosted server for a decision: the writer's public label for the body line. */
  decidedBy: z.string().max(80).optional(),
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
