// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Shared Intent metadata is also validated in the Convex non-Node runtime.
import { z } from 'zod';
import { digest } from './state/hash.js';
import {
  PURGED_ITEM_TITLE,
  planningPutSchema,
  retainedPlanningPutSchema,
  planningCommentCommandSchema,
  planningPurgeSchema,
  planningCommentPurgeSchema,
} from './work-planning-types.js';
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
/** An intent row as the journal stores it. */
const storedIntentSchema = intentCreateSchema.extend({ base: oid, hostedBase: channelBaseSchema.optional() });
export const intentMetadataCommandSchema = z.discriminatedUnion('action', [
  storedIntentSchema,
  intentNoteSchema,
  intentStatusSchema,
]);
export const metadataCommandSchema = z.union([
  intentMetadataCommandSchema,
  planningPutSchema,
  planningCommentCommandSchema,
]);
/** Every command a stored Work journal row may hold: client commands plus the server-only purge. */
export const journalCommandSchema = z.union([
  retainedPlanningPutSchema,
  metadataCommandSchema,
  planningPurgeSchema,
  planningCommentPurgeSchema,
]);
export type IntentMetadataCommand = z.infer<typeof intentMetadataCommandSchema>;
export type MetadataCommand = z.infer<typeof metadataCommandSchema>;

// What a purged Work journal row keeps (Item 4c9e961e, purge Lanes 1 and 2). Here, not in its own module, so the
// CLI and MCP load no extra module.

/**
 * Every field of every command a purge redacts, in one of three classes: `keep` (structure a replay needs: ids,
 * versions, status, links, Initiative, parent, thread, base), `words` (replaced by the fixed value given) or `drop`
 * (free text or attribution that no replay needs). A keep-list: a field not named here is dropped, and
 * tests/planning-purge-v2.test.mjs fails when a schema gains a field that is not classified.
 */
export const purgeFieldClasses = {
  'put-planning-item': {
    keep: [
      'action',
      'operationId',
      'itemId',
      'expectedVersion',
      'kind',
      'status',
      'intentIds',
      'initiativeId',
      'order',
      'parentId',
      'restoredTopLevel',
      'relations',
      'hidden',
      'agent',
      'agentClient',
    ],
    words: { title: PURGED_ITEM_TITLE, body: '' },
    drop: [
      'reason',
      'type',
      'owner',
      'waitingOn',
      'imported',
      'statusPin',
      'statusPinBy',
      'statusPinUndo',
      'statusPinRestore',
      'statusSource',
    ],
  },
  // authorLabel is free text the client sends; decidedBy, agent and agentClient are server-set or checked against
  // fixed public shapes (handle, agent slug, tool:model), the same identities the row's envelope already records.
  'comment-planning-item': {
    keep: ['action', 'operationId', 'itemId', 'replyTo', 'decision', 'agent', 'agentClient', 'decidedBy'],
    words: { authorLabel: '', text: 'Deleted comment' },
    // Bindings and the checklist wording digest must not survive the comment's purge.
    drop: ['attachments', 'line'],
  },
  intent: {
    keep: ['action', 'base', 'baseChannel', 'hostedBase'],
    words: { outcome: PURGED_ITEM_TITLE, constraints: '' },
    drop: [],
  },
  note: {
    keep: ['action', 'intentId', 'kind'],
    words: { text: 'Deleted note' },
    drop: ['anchor'],
  },
} as const;

/** The commands a purge redacts: an Item's puts and comments (also through an alias or its Intent id), and an
 * Intent-born Item's intent row and Lane notes. Parsed strictly, so a stored row with an extra key is refused. */
export const purgeableCommandSchema = z.discriminatedUnion('action', [
  retainedPlanningPutSchema,
  planningCommentCommandSchema,
  storedIntentSchema,
  intentNoteSchema,
]);
export type PurgeableCommand = z.infer<typeof purgeableCommandSchema>;
const strictFactsSchema = z.discriminatedUnion('action', [
  retainedPlanningPutSchema.strict(),
  planningCommentCommandSchema.strict(),
  storedIntentSchema.strict(),
  intentNoteSchema.strict(),
]);

/** A purged row's facts: its own command with every word replaced and every structural field kept, so a replay
 * rebuilds the Item's history, links and Intent exactly and only its words are gone. A fixed point. */
export function redactPlanningWrite<T extends PurgeableCommand>(command: T): T {
  const fields = purgeFieldClasses[command.action];
  const source = command as Record<string, unknown>,
    out: Record<string, unknown> = {};
  for (const key of fields.keep) if (source[key] !== undefined) out[key] = source[key];
  for (const [key, word] of Object.entries(fields.words)) if (source[key] !== undefined) out[key] = word;
  return out as T;
}

/** The stored text of a purged row's facts. A purge records their digest per row (planningPurgeSchema `rows`),
 * computed while the row was whole, so readers check the stored facts, not a self-declared form. */
export const purgedFactsText = (command: PurgeableCommand) => JSON.stringify(redactPlanningWrite(command));

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
/** The digest a purge records for one row: of its redacted facts in canonical key order, so a reader that parsed
 * the stored facts (strictly, no key added or dropped) gets the same value as the purge step that wrote them. */
export const purgedFactsDigest = (facts: PurgeableCommand) => digest(JSON.stringify(canonical(facts)));
const wordsFree = (command: PurgeableCommand) =>
  JSON.stringify(canonical(redactPlanningWrite(command))) === JSON.stringify(canonical(command));

/** Stored facts, parsed strictly (no unknown key survives) and required to hold no words. */
export const purgedFactsSchema = strictFactsSchema.refine(wordsFree, 'A purged Work row still holds words.');

/** What a journal reader hands the reducer for a purged row: the purge it names and the row's redacted command
 * (its envelope and request hash stay on the row). Readers build it from the row's purged marker after checking that
 * the purge exists, is whole, comes later and lists the row with the digest of its stored facts
 * (convex/projectWorkPurgedRows.ts, src/work-planning-purge.ts). */
export const purgedPlanningRowSchema = z.object({
  action: z.literal('purged-planning-row'),
  purgeOperationId: id,
  command: purgedFactsSchema,
});
export type PurgedPlanningRow = z.infer<typeof purgedPlanningRowSchema>;
