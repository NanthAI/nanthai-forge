import { conversationSchema } from './agent-edit-types.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { workActorSchema } from './work-actor-types.js';
const id = z.uuid();
const text = z.string().trim().min(1);
export const decisionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }),
  z.object({ kind: z.literal('intent'), intentId: id }),
]);
export const decisionOverrideSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), decisionId: id, link: text.optional() }),
  z.object({ kind: z.literal('default'), description: text, link: text.optional() }),
]);
export const decideInputSchema = z.object({
  conversation: conversationSchema.optional(),
  operationId: id.optional(),
  target: decisionTargetSchema,
  decidedBy: text,
  what: text,
  why: text,
  // Historical decisions may have a known day without a known time.
  decidedAt: z.union([z.iso.datetime(), z.iso.date()]).optional(),
  overrides: decisionOverrideSchema.optional(),
  supersedes: id.optional(),
  actor: workActorSchema.shape.name.optional(),
  tool: workActorSchema.shape.tool,
});
export const decisionsInputSchema = z.object({
  target: decisionTargetSchema.optional(),
});
export const decisionRecordSchema = z.object({
  conversation: conversationSchema.optional(),
  schema: z.literal(1),
  kind: z.literal('decision'),
  id,
  operationId: id,
  request: z.string().regex(/^[a-f0-9]{64}$/),
  target: decisionTargetSchema,
  decidedBy: text,
  what: text,
  why: text,
  at: z.iso.datetime(),
  decidedAt: z.union([z.iso.datetime(), z.iso.date()]),
  overrides: decisionOverrideSchema.optional(),
  supersedes: id.optional(),
  actor: workActorSchema,
  requester: workActorSchema,
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
export type DecisionTarget = DecisionRecord['target'];
export const sameDecisionTarget = (a: DecisionTarget, b: DecisionTarget) =>
  a.kind === b.kind && (a.kind === 'project' || (b.kind === 'intent' && a.intentId === b.intentId));

/** Supersession is derived from retained replacement records; no earlier fact is rewritten.
 * Multiple explicit replacements remain visible rather than silently choosing one. */
export function decisionContext(records: DecisionRecord[], intentId?: string) {
  const replacements = new Map<string, string[]>();
  for (const record of records) {
    if (!record.supersedes) continue;
    const ids = replacements.get(record.supersedes) ?? [];
    ids.push(record.id);
    replacements.set(record.supersedes, ids);
  }
  const relevant = records.filter(
    record => record.target.kind === 'project' || record.target.intentId === intentId,
  );
  return {
    active: relevant.filter(record => !replacements.has(record.id)),
    superseded: relevant
      .filter(record => replacements.has(record.id))
      .map(record => ({
        id: record.id,
        target: record.target,
        what: record.what,
        status: 'superseded' as const,
        supersededBy: replacements.get(record.id)!,
      })),
  };
}
export type DecisionContext = ReturnType<typeof decisionContext>;
