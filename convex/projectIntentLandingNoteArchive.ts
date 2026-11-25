// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { landingCapsulePointer } from './projectLandingCapsuleStore';
import { invariant } from '../src/errors';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { landingNoteId } from '../src/intent-landing-note';

type NoteRow = Doc<'projectIntentLandingNotes'>;
export type HotLandingNote = Extract<NoteRow, { commit: string }>;
export type ArchivedNote = { key: string; submissionId: string; intentId: string };
export type ArchivedNotePin = ArchivedNote & { pointer: LandingCapsulePointer };
export type LoadedLandingNote = ArchivedNote & { sha256: string; row: HotLandingNote };

export function landingNoteOrder(row: Pick<NoteRow, '_creationTime' | 'intentId' | 'receiptId' | 'kind'>) {
  return `${row._creationTime.toFixed(6).padStart(22, '0')}:${landingNoteId(row)}`;
}

/** The row and its index position survive retries, while the canonical body moves out of Convex. */
export async function retainLandingNoteReference(
  ctx: MutationCtx,
  submissionId: string,
  row: HotLandingNote,
) {
  await ctx.db.replace(row._id, {
    projectId: row.projectId,
    intentId: row.intentId,
    receiptId: row.receiptId,
    kind: row.kind,
    at: row.at,
    laneIds: row.laneIds,
    ...(row.viaLaneId ? { viaLaneId: row.viaLaneId } : {}),
    ...(row.revertOf ? { revertOf: row.revertOf } : {}),
    ...(row.revertedBy ? { revertedBy: row.revertedBy } : {}),
    ...(row.landedBy ? { landedBy: { by: row.landedBy.by } } : {}),
    capsule: submissionId,
  });
}

export async function landingNoteWindow(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intentId: string,
  limit: number,
  through?: string,
  includeThrough = true,
) {
  return await ctx.db
    .query('projectIntentLandingNotes')
    .withIndex('by_project_and_intent_and_at', q => {
      const range = q.eq('projectId', projectId).eq('intentId', intentId);
      if (through === undefined) return range;
      return includeThrough ? range.lte('at', through) : range.lt('at', through);
    })
    .order('desc')
    .take(limit);
}

export const archiveNoteReference = (note: Extract<NoteRow, { capsule: string }>): ArchivedNote => ({
  key: landingNoteOrder(note),
  submissionId: note.capsule,
  intentId: note.intentId,
});

export async function pinArchivedNotes(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  references: ArchivedNote[],
): Promise<ArchivedNotePin[]> {
  return await Promise.all(
    references.map(async reference => {
      const pointer = await landingCapsulePointer(ctx, { projectId, submissionId: reference.submissionId });
      invariant(pointer, 'SOURCE_UNAVAILABLE', 'The landing note’s capsule is unavailable.');
      // Transaction replay pins can be large and are irrelevant to read-through.
      const contentPin = { ...pointer };
      delete contentPin.summary;
      return { ...reference, pointer: contentPin };
    }),
  );
}
