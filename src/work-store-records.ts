// SPDX-License-Identifier: Apache-2.0
// Flip 5 (Issue 0695ab24): journal index rows as Work store records. Pure and runtime-neutral, shared by
// the paged copy, the read-only compare and the dual write, so all three agree on one shape.
import { planningItemSchema, planningCommentSchema } from './work-planning-types.js';
import { noteSchema } from './work-types.js';
import { digest } from './portable-hash.js';
import type { HostedRecord } from './hosted-records.js';

/** Journal index collections the copy moves, in copy order. */
export const workStoreSources = [
  'planningVersions',
  'planningComments',
  'notes',
  'intents',
  'lifecycle',
] as const;
export type WorkStoreSource = (typeof workStoreSources)[number];

/** Older notes and every lifecycle move carry no id; their index key `INTENT:INDEX` names them, so the
 * record id derives from it. */
export function noteRecordId(intentId: string, index: number, kind: 'note' | 'lifecycle' = 'note') {
  const h = digest(`forge-work-${kind}:${intentId}:${index}`);
  const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A journal Intent as an `intent` record at `version`. Fields hosted Intents share keep their names; the
 * rest stay verbatim under `journal`. Notes, lifecycle, their counters and `conversation` (the order of the
 * Intent's notes and comments, which are `comment` records with this parent) are left out, so a note or a
 * comment never makes a new Intent version. An Intent with no recorded creator was the project owner's. */
function intentRecord(value: Record<string, unknown>, owner: string, version: number): HostedRecord {
  const { id, outcome, constraints, status, base, creatorAccountId, assigneeAccountIds, ...rest } = value;
  const journal: Record<string, unknown> = { ...rest };
  for (const name of [
    'notes',
    'lifecycle',
    'noteCount',
    'lifecycleCount',
    'conversation',
    'payload',
    'payloadKey',
    'payloadParts',
  ])
    delete journal[name];
  return {
    kind: 'intent',
    id: id as string,
    version,
    at: (rest.updatedAt ?? rest.createdAt) as string,
    outcome: outcome as string,
    constraints: (constraints as string | undefined) ?? '',
    creatorAccountId: (creatorAccountId as string | undefined) ?? owner,
    assigneeAccountIds: (assigneeAccountIds as string[] | undefined) ?? [],
    ...(typeof base === 'string' ? { base: { head: base } } : {}),
    status: status as 'active',
    journal,
  };
}

/** The record one index row becomes; throws when the row does not read under its schema. `owner` and
 * `version` apply to Intents only: an Intent is mutable, so the caller names the version it writes. */
export function workStoreRecord(
  collection: WorkStoreSource,
  value: unknown,
  intent: { owner: string; version: number } = { owner: '', version: 0 },
): HostedRecord {
  if (collection === 'planningVersions') {
    const item = planningItemSchema.parse(value);
    return { kind: 'issue', id: item.id, version: item.version, at: item.at, item };
  }
  if (collection === 'planningComments') {
    const comment = planningCommentSchema.parse(value);
    return {
      kind: 'comment',
      id: comment.id,
      version: 0,
      at: comment.at,
      parent: comment.itemId,
      position: 0,
      comment,
    };
  }
  if (collection === 'intents')
    return intentRecord(value as Record<string, unknown>, intent.owner, intent.version);
  const { intentId, index, ...entry } = value as { intentId: string; index: number } & Record<
    string,
    unknown
  >;
  if (collection === 'lifecycle')
    return {
      kind: 'lifecycle',
      id: noteRecordId(intentId, index, 'lifecycle'),
      version: 0,
      at: entry.at as string,
      parent: intentId,
      position: index,
      entry: entry as { from: string; to: string; at: string },
    };
  const note = noteSchema.parse(value);
  return {
    kind: 'comment',
    id: note.id ?? noteRecordId(intentId, index),
    version: 0,
    at: note.at,
    parent: intentId,
    position: index,
    note,
  };
}

/** What the journal index row of a stored Work record held (`undefined` for other kinds). Heads of these
 * kinds keep it inline, so a planning page reads one document per row, as the journal did. */
export function journalRow(record: Record<string, unknown> & { kind: string }): unknown {
  if (record.kind === 'issue') return record.item;
  if (record.kind === 'comment' && record.comment) return record.comment;
  if (record.kind === 'comment' || record.kind === 'lifecycle')
    return { ...((record.note ?? record.entry) as object), intentId: record.parent, index: record.position };
  return undefined;
}
