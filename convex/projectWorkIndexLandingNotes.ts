// SPDX-License-Identifier: Apache-2.0
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

type RecordRow = { id: string; position: number; value: string };
type CommentPage = { page: RecordRow[]; isDone: boolean; continueCursor: string };
type Input = {
  collection: string;
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
  offset: z.number().int().min(linksPerPage),
  recordsCursor: z.string(),
  recordsDone: z.boolean(),
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
      parsed.data.itemId === input.parentId &&
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
  if (input.collection !== 'planningComments' || !input.parentId || (!newestEnd && !continuation))
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
  );
  const ordered = [...page.page].sort((a, b) => b.position - a.position);
  const rows: RecordRow[] = [...page.page];
  for (const note of notes) {
    let position = note.position;
    if (!timePositions && ordered.length) {
      const time = Date.parse(note.value.at);
      const before = ordered.find(row => commentTime(row) <= time);
      position = before ? before.position + 0.5 : ordered.at(-1)!.position - 0.5;
    }
    rows.push({ id: note.value.id, position, value: JSON.stringify(note.value) });
  }
  const next = offset + linksPerPage;
  const recordsCursor = continuation?.recordsCursor ?? page.continueCursor;
  const recordsDone = continuation?.recordsDone ?? page.isDone;
  const more = next < links.length;
  return {
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
        })
      : recordsCursor,
  };
}

function commentTime(row: RecordRow) {
  try {
    return Date.parse((JSON.parse(row.value) as { at?: string }).at ?? '') || 0;
  } catch {
    return 0;
  }
}
