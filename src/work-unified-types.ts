// SPDX-License-Identifier: Apache-2.0
// Format 18 composes historical unified format 16 with format-17 landing batches.
import { z } from 'zod';
import { invariant } from './errors.js';
import { intentSchema, workSchema, type WorkData } from './work-types.js';
import { planningItemSchema } from './work-planning-types.js';

export const unifiedWorkFormat = 18;
const id = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const intentMembershipSchema = z
  .object({
    initiativeId: id,
    order: z.number().int().nonnegative(),
    sourceId: id,
  })
  .passthrough();
export const unifiedIntentSchema = intentSchema
  .extend({
    title: z.string(),
    outcome: z.string(),
    description: z.string(),
    base: intentSchema.shape.base.optional(),
    status: z.enum(['proposed', 'active', 'completed', 'abandoned']),
    version: z.number().int().positive().optional(),
    previousVersion: z.number().int().nonnegative().optional(),
    operationId: id.optional(),
    request: planningItemSchema.shape.request.optional(),
    updatedAt: z.string().optional(),
    creatorAccountId: z.string().optional(),
    assigneeAccountIds: z.array(z.string()).optional(),
    provenance: z.string().optional(),
    memberships: z.array(intentMembershipSchema),
    relatedIntentIds: z.array(id),
    historyRefs: z.array(z.object({ itemId: id, version: z.number().int().positive() })),
    conversation: z.array(
      z.discriminatedUnion('kind', [
        z.object({ id, kind: z.literal('note'), index: z.number().int().nonnegative() }),
        z.object({ id, kind: z.literal('planning-comment'), itemId: id }),
      ]),
    ),
  })
  .passthrough();
export type UnifiedIntent = z.infer<typeof unifiedIntentSchema>;
export const initiativeSchema = planningItemSchema
  .extend({
    kind: z.literal('initiative'),
    parentId: id.optional(),
  })
  .passthrough();
export const intentAliasSchema = z.object({ aliasId: id, intentId: id });
const counts = z.record(z.string(), z.number().int().nonnegative());
export const intentMergeReceiptSchema = z.object({
  converter: z.literal('intent-merge-v1'),
  fromSchema: z.union([z.literal(15), z.literal(17)]),
  toSchema: z.union([z.literal(16), z.literal(18)]),
  counts: z.object({ before: counts, after: counts, foldedPairs: z.number().int().nonnegative() }),
  hashes: z.object({ input: hash, output: hash, intents: hash, planningItems: hash, planningComments: hash }),
});
export const unifiedWorkSchema = z
  .object({
    ...workSchema.shape,
    schema: z.union([z.literal(16), z.literal(18)]),
    intents: z.array(unifiedIntentSchema),
    initiatives: z.array(initiativeSchema),
    intentAliases: z.array(intentAliasSchema),
    // Exact legacy objects, including extensions, preserve conflicting facts and request bytes.
    legacyIntentMerge: z.object({
      intents: z.array(z.unknown()),
      planningItems: z.array(z.unknown()),
      planningComments: z.array(z.unknown()),
      fields: z.record(z.string(), z.unknown()),
    }),
    intentMergeReceipt: intentMergeReceiptSchema,
  })
  .passthrough();
export type UnifiedWorkData = z.infer<typeof unifiedWorkSchema>;
// Selected-record reads see only manifest fields; collections and legacy pages load separately.
const partialUnifiedWorkSchema = unifiedWorkSchema.extend({
  initiatives: unifiedWorkSchema.shape.initiatives.default([]),
  intentAliases: unifiedWorkSchema.shape.intentAliases.default([]),
  legacyIntentMerge: unifiedWorkSchema.shape.legacyIntentMerge.optional(),
});
export const isUnifiedWork = (value: unknown) =>
  !!value && typeof value === 'object' && [16, 18].includes((value as { schema?: unknown }).schema as number);
/**
 * Validate stored Work with the schema its format names. Schema-16 Intents may lack `base`
 * until their first Lane captures it; execution readers reach Intents through Lanes and Views.
 */
export function safeParseWork(raw: unknown, partial = false) {
  const schema = !isUnifiedWork(raw) ? workSchema : partial ? partialUnifiedWorkSchema : unifiedWorkSchema;
  return schema.safeParse(raw) as { success: true; data: WorkData } | { success: false; error: z.ZodError };
}
export function parseWork(raw: unknown, partial = false): WorkData {
  const result = safeParseWork(raw, partial);
  invariant(
    result.success,
    'INVALID_WORK_STORE',
    'Work does not match its declared format. Existing work is preserved.',
  );
  return result.data;
}
