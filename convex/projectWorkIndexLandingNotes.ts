// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { PaginationOptions } from 'convex/server';
import { z } from 'zod';
import { invariant } from '../src/errors';
import { LANDING_NOTES_PER_ITEM } from '../src/intent-landing-note';
import { plannedLinkIds } from '../src/work-planning-lifecycle';
import type { PlanningItem } from '../src/work-planning-types';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { publicWorkPlan } from './publicWorkPlan';
import { readProjectRole } from './projectAuthority';
import { intentLandingComments } from './projectIntentLandingNotes';
import {
  pinArchivedNotes,
  type ArchivedNotePin,
  type LoadedLandingNote,
} from './projectIntentLandingNoteArchive';
import { historyViewVersion } from './projectLandingCapsuleContext';
import { digest } from '../src/state/hash';

type RecordRow = { id: string; position: number; value: string };
type CommentPage = {
  page: RecordRow[];
  isDone: boolean;
  continueCursor: string;
  journalHistory?: true;
  viewVersion?: string;
  landingNotePins?: ArchivedNotePin[];
};
type Input = {
  collection: string;
  memberCommentsOnly?: true;
  parentId?: string;
  newestFirst?: boolean;
  paginationOpts: PaginationOptions;
};
type Item = Pick<PlanningItem, 'id' | 'kind' | 'intentIds'>;
const linkedCursorPrefix = 'forge-linked-landing-notes:';
// At most eight Intent chains, each with up to 17 steps and 50 notes per step.
const linksPerPage = 8;
const linkedCursor = z.object({
  itemId: z.string(),
  newestFirst: z.boolean(),
  offset: z.number().int().nonnegative().multipleOf(linksPerPage),
  recordsCursor: z.string(),
  recordsDone: z.boolean(),
  noteBefore: z
    .object({ at: z.number().nonnegative(), intentId: z.string(), skip: z.number().int().min(1).max(512) })
    .optional(),
});
type LinkedCursor = z.infer<typeof linkedCursor>;

export function linkedLandingCursor(cursor: string | null | undefined, input: Input): LinkedCursor | null {
  if (!cursor?.startsWith(linkedCursorPrefix)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(cursor.slice(linkedCursorPrefix.length));
  } catch {
    decoded = null;
  }
  const parsed = linkedCursor.safeParse(decoded);
  invariant(
    parsed.success &&
      input.collection === 'planningComments' &&
      !input.memberCommentsOnly &&
      parsed.data.itemId === input.parentId &&
      (parsed.data.offset > 0 || parsed.data.noteBefore !== undefined) &&
      parsed.data.newestFirst === Boolean(input.newestFirst),
    'BAD_ARGUMENT',
    'Use the returned cursor for this Item’s comments.',
  );
  return parsed.data;
}

/** Insert receipt-backed notes at the newest end of the discussion. An Item with more links
 * continues with the existing comment cursor, so even large merges stay within query budgets. */
export async function withLandingNotes(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  input: Input,
  page: CommentPage,
  readItem: (id: string) => Promise<unknown>,
  timePositions: boolean,
  continuation: LinkedCursor | null,
): Promise<CommentPage> {
  const newestEnd = input.newestFirst ? !input.paginationOpts.cursor : page.isDone;
  if (
    input.collection !== 'planningComments' ||
    input.memberCommentsOnly ||
    !input.parentId ||
    (!newestEnd && !continuation)
  )
    return page;
  const itemId = input.parentId;
  const item = (await readItem(itemId)) as Item | null;
  const links = item?.kind === 'issue' && Array.isArray(item.intentIds) ? plannedLinkIds(item) : [itemId];
  const offset = continuation?.offset ?? 0;
  let pageLinks = links.slice(offset, offset + linksPerPage);
  let chainRoots: ReadonlySet<string> | undefined = new Set(links);
  if (links.length > 1 && project.visibility === 'public') {
    const viewer = await ctx.auth.getUserIdentity();
    if (!viewer || !(await readProjectRole(ctx, project, viewer.subject))) {
      const plan = publicWorkPlan(ctx, project, new Map());
      const visible = await Promise.all(pageLinks.map(link => link === itemId || plan.allowed(link)));
      pageLinks = pageLinks.filter((_, index) => visible[index]);
      chainRoots = undefined;
    }
  }
  const notes = await intentLandingComments(
    ctx,
    project._id,
    itemId,
    LANDING_NOTES_PER_ITEM,
    pageLinks,
    chainRoots,
    continuation?.noteBefore,
  );
  const ordered = [...page.page].sort((a, b) => b.position - a.position);
  const rows: RecordRow[] = [...page.page];
  for (const note of notes.comments) {
    let position = note.position;
    if (!timePositions && ordered.length) {
      const time = Date.parse(note.value.at);
      const before = ordered.find(row => commentTime(row) <= time);
      position = before ? before.position + 0.5 : ordered.at(-1)!.position - 0.5;
    }
    rows.push({ id: note.value.id, position, value: JSON.stringify(note.value) });
  }
  const next = notes.before ? offset : offset + linksPerPage;
  const recordsCursor = continuation?.recordsCursor ?? page.continueCursor;
  const recordsDone = continuation?.recordsDone ?? page.isDone;
  const more = notes.before !== undefined || next < links.length;
  const result: CommentPage = {
    page: rows.sort((a, b) => (input.newestFirst ? b.position - a.position : a.position - b.position)),
    isDone: recordsDone && !more,
    continueCursor: more
      ? linkedCursorPrefix +
        JSON.stringify({
          itemId,
          newestFirst: Boolean(input.newestFirst),
          offset: next,
          recordsCursor,
          recordsDone,
          ...(notes.before ? { noteBefore: notes.before } : {}),
        })
      : recordsCursor,
  };
  if (!notes.pending.length) return result;
  if ((ctx as QueryCtx & { landingNotesLoaded?: LoadedLandingNote[] }).landingNotesLoaded)
    return {
      ...result,
      journalHistory: true,
      landingNotePins: await pinArchivedNotes(ctx, project._id, notes.pending),
    };
  // The existing archive page adapter handles this marker in both the browser and released CLI.
  // Only the private bridge receives the original storage pins.
  return {
    ...result,
    journalHistory: true,
    viewVersion: digest(JSON.stringify([await historyViewVersion(ctx, project), notes.pending])),
  };
}

function commentTime(row: RecordRow) {
  try {
    return Date.parse((JSON.parse(row.value) as { at?: string }).at ?? '') || 0;
  } catch {
    return 0;
  }
}
