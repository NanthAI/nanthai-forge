// SPDX-License-Identifier: Apache-2.0
// Flip 5 (Issue 0695ab24): journal index rows as Work store records. Pure and runtime-neutral, shared by
// the paged copy, the read-only compare and later the dual write, so all three agree on one shape.
import { planningItemSchema, planningCommentSchema } from './work-planning-types.js';
import { noteSchema } from './work-types.js';
import { digest } from './portable-hash.js';
import type { HostedRecord } from './hosted-records.js';

/** Journal index collections the copy moves, in copy order. */
export const workStoreSources = ['planningVersions', 'planningComments', 'notes'] as const;
export type WorkStoreSource = (typeof workStoreSources)[number];

/** Older notes carry no id; their index key `INTENT:INDEX` names them, so the record id derives from it. */
export function noteRecordId(intentId: string, index: number) {
  const h = digest(`forge-work-note:${intentId}:${index}`);
  const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The record one index row becomes; throws when the row does not read under its schema. */
export function workStoreRecord(collection: WorkStoreSource, value: unknown): HostedRecord {
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
  const { intentId, index } = value as { intentId: string; index: number };
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
