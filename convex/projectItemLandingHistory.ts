// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { maxIntentChain } from '../src/hosted-intent-chain';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { landingNoteWindow } from './projectIntentLandingNoteArchive';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { invariant } from '../src/errors';

export const ITEM_LANDINGS_PAGE = 10;

export type ItemLanding = {
  receiptId: string;
  commit: string;
  at: string;
  sequence?: number;
  landedBy?: string;
  revertedBy?: string;
};

type LaneStamp = NonNullable<Doc<'projectHostedOverlapLanes'>['landed']>;
type LaneEvidence = {
  heads: ReadonlyMap<string, Doc<'projectHostedRecordHeads'>[]>;
  stamps: ReadonlyMap<string, LaneStamp | undefined>;
};

export function itemLandingStamp(stamp: LaneStamp): ItemLanding {
  return {
    receiptId: stamp.receiptId,
    commit: stamp.commit,
    at: stamp.at,
    ...(stamp.revertedBy ? { revertedBy: stamp.revertedBy.receiptId } : {}),
  };
}

export async function itemLaneLandingStamp(ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  return (
    await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
      .unique()
  )?.landed;
}

// Creation-time ties can occur between adjacent writes. Keep cursor lookbehind
// proportional to a small batch, including when someone constructs a cursor.
const timePosition = z.object({ at: z.number().min(0), skip: z.number().int().min(1).max(512) });
const notePosition = z.union([timePosition, z.literal(false), z.null()]);
const legacyPosition = z.object({ intent: z.number().int().min(0), time: timePosition.optional() });
export const landingHistoryCursor = z.object({
  notes: z
    .array(notePosition)
    .max(maxIntentChain + 1)
    .nullable()
    .optional(),
  legacy: legacyPosition.nullable().optional(),
});
type HistoryCursor = z.infer<typeof landingHistoryCursor>;
type TimePosition = z.infer<typeof timePosition>;
type NotePosition = z.infer<typeof notePosition>;
type LegacyPosition = z.infer<typeof legacyPosition>;
type NoteWindow = Awaited<ReturnType<typeof landingNoteWindow>>;

/** Archive routes retain Lane membership. Canonical receipts already hold the other Item Work fields. */
export async function itemLandingFromNote(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  note: NoteWindow[number],
): Promise<ItemLanding> {
  let evidence: Pick<ItemLanding, 'commit' | 'at' | 'sequence'>;
  if ('commit' in note) {
    evidence = { commit: note.commit, at: note.at, sequence: note.sequence };
  } else {
    const row = await acceptanceRow(ctx, { projectId, receiptId: note.receiptId });
    invariant(row, 'SOURCE_UNAVAILABLE', 'The archived note’s landing receipt is unavailable.');
    const receipt = JSON.parse(row.value) as HostedAcceptance;
    evidence = { commit: receipt.candidate.head, at: receipt.at, sequence: receipt.snapshot.revision };
  }
  return {
    receiptId: note.receiptId,
    ...evidence,
    ...(note.landedBy ? { landedBy: note.landedBy.by } : {}),
  };
}

function windowFrom<T extends { _creationTime: number }>(rows: T[], from: TimePosition | undefined) {
  if (!from) return rows;
  let offset = 0;
  while (offset < from.skip && rows[offset]?._creationTime === from.at) offset++;
  return rows.slice(offset);
}

function windowAfter(
  rows: readonly { _creationTime: number }[],
  consumed: number,
  from: TimePosition | undefined,
): TimePosition {
  const at = rows[consumed - 1]!._creationTime;
  let skip = from?.at === at ? from.skip : 0;
  while (consumed > 0 && rows[--consumed]!._creationTime === at) skip++;
  return { at, skip };
}

/** Merge the recorded note windows without adding an index to the landing path.
 * A cursor consumes rows only from the windows it showed. Writes above the
 * boundary do not shift older rows, and tied creation times advance per Intent. */
async function notePage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intents: readonly string[],
  from: NotePosition[] | undefined,
  limit: number,
) {
  const rawLimit = 2 * limit;
  const streams = await Promise.all(
    (from ?? intents.map(() => false as const)).map(async (position, index) => {
      const intentId = intents[index];
      if (!intentId || position === null) return { position, rows: [] as NoteWindow, consumed: 0 };
      const time = position || undefined;
      const rows = await landingNoteWindow(
        ctx,
        projectId,
        intentId,
        rawLimit + 1 + (time?.skip ?? 0),
        time?.at,
      );
      return { position, rows: windowFrom(rows, time), consumed: 0 };
    }),
  );
  const merged = streams.flatMap(stream => stream.rows.map(note => ({ note, stream })));
  merged.sort((a, b) => b.note._creationTime - a.note._creationTime);
  const receipts = new Map<string, NoteWindow[number]>();
  for (const { note, stream } of merged.slice(0, rawLimit)) {
    stream.consumed++;
    if (note.kind !== 'landed') continue;
    receipts.set(note.receiptId, note);
    if (receipts.size === limit) break;
  }
  const next = streams.map(({ position, rows, consumed }) =>
    consumed >= rows.length ? null : consumed ? windowAfter(rows, consumed, position || undefined) : position,
  );
  return {
    rows: await Promise.all([...receipts.values()].map(note => itemLandingFromNote(ctx, projectId, note))),
    next: next.some(value => value !== null) ? next : null,
  };
}

async function hasLandingNote(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intentId: string,
  receiptId: string,
) {
  const hot = await ctx.db
    .query('projectIntentLandingNotes')
    .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
      q.eq('projectId', projectId).eq('receiptId', receiptId).eq('intentId', intentId).eq('kind', 'landed'),
    )
    .unique();
  return !!hot;
}

/** Older projects recorded their last landing per Lane. Walk only the Item's Lane
 * heads, probing at most one page of stamps and omitting any covered by notes. */
async function legacyLandingPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intents: readonly string[],
  from: LegacyPosition | undefined,
  limit: number,
  existing?: LaneEvidence,
) {
  const receipts = new Map<string, ItemLanding>();
  let remaining = limit;
  for (let i = from?.intent ?? 0; i < intents.length; i++) {
    const intentId = intents[i]!;
    const time = from?.intent === i ? from.time : undefined;
    const known = existing?.heads.get(intentId);
    const heads = known
      ? known.filter(head => !time || head._creationTime <= time.at)
      : await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q => {
            const range = q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId);
            return time ? range.lte('_creationTime', time.at) : range;
          })
          .order('desc')
          .take(remaining + 1 + (time?.skip ?? 0));
    const older = windowFrom(heads, time);
    const page = older.slice(0, remaining);
    const stamps = await Promise.all(
      page.map(async lane => {
        const stamp = existing?.stamps.has(lane.key)
          ? existing.stamps.get(lane.key)
          : await itemLaneLandingStamp(ctx, projectId, lane.key);
        return stamp && !(await hasLandingNote(ctx, projectId, intentId, stamp.receiptId)) ? stamp : null;
      }),
    );
    for (const stamp of stamps) if (stamp) receipts.set(stamp.receiptId, itemLandingStamp(stamp));
    if (older.length > remaining)
      return {
        rows: [...receipts.values()],
        used: limit,
        next: { intent: i, time: windowAfter(page, page.length, time) },
      };
    remaining -= page.length;
    if (remaining === 0 && i + 1 < intents.length)
      return { rows: [...receipts.values()], used: limit, next: { intent: i + 1 } };
  }
  return { rows: [...receipts.values()], used: limit - remaining, next: null };
}

/** A single bounded page, with the legacy scan continuing after the notes. */
export async function itemLandingHistory(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intents: readonly string[],
  cursor: HistoryCursor,
  limit = ITEM_LANDINGS_PAGE,
  existing?: LaneEvidence,
) {
  const notes =
    cursor.notes === null ? undefined : await notePage(ctx, projectId, intents, cursor.notes, limit);
  const nextNotes = notes?.next ?? null;
  const remaining = limit - (notes?.rows.length ?? 0);
  const stamps =
    nextNotes === null && cursor.legacy !== null && remaining
      ? await legacyLandingPage(ctx, projectId, intents, cursor.legacy, remaining, existing)
      : undefined;
  const legacy = stamps ? stamps.next : cursor.legacy;
  return {
    rows: [
      ...new Map([...(stamps?.rows ?? []), ...(notes?.rows ?? [])].map(row => [row.receiptId, row])).values(),
    ],
    used: (notes?.rows.length ?? 0) + (stamps?.used ?? 0),
    next: nextNotes === null && legacy === null ? null : { notes: nextNotes, legacy },
  };
}

export function cursorJson(cursor: string) {
  try {
    return JSON.parse(cursor) as unknown;
  } catch {
    return null;
  }
}
