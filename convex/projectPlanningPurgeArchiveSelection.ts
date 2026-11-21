// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import type { JournalIndex } from '../src/journal-segment';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';
import { internalQuery, internalMutation } from './server';
import { receiptRow } from './projectJournalMaintenance';
import type { selectEventRows } from './projectPlanningPurgeSelect';
import {
  archivedSegmentRows,
  archivedTargetPage,
  archiveTargetCursor,
  type TargetCursor,
} from './projectPlanningArchiveIndex';

export type ArchiveSelection = ReturnType<typeof selectEventRows>;
export const archiveSelectionValues = v.object({
  rows: v.array(
    v.object({ operationId: v.string(), revision: v.number(), digest: v.string(), request: v.string() }),
  ),
  decisions: v.array(v.array(v.string())),
  created: v.union(v.number(), v.null()),
  creates: v.boolean(),
});

const frontier = v.union(v.null(), v.object({ from: v.number(), key: v.string(), sha256: v.string() }));
export const archivePin = v.object({
  frontier,
  rewriteRevision: v.number(),
  indexedRevision: v.optional(v.number()),
});
export type ArchivePin = typeof archivePin.type;
export type SelectionProgress = ArchivePin & {
  request: string;
  indexedAfter?: TargetCursor;
  done: boolean;
  selected: ArchiveSelection;
};

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
const args = { ...identity, itemId: v.string(), ids: v.array(v.string()) };
const key = (operationId: string) => `purge-selection:${operationId}`;
const archiveChanged =
  'An archived Work event segment changed while selecting the Item. Run the same purge again to resume.';

const eventSegments = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, after?: number) =>
  ctx.db.query('projectJournalSegments').withIndex('by_project_and_scope_and_from', q => {
    const events = q.eq('projectId', projectId).eq('scope', 'events');
    return after === undefined ? events : events.gt('from', after);
  });

function segmentEntry(row: Doc<'projectJournalSegments'>) {
  const index = JSON.parse(row.value) as JournalIndex;
  return { index, pin: { from: row.from, key: row.key, sha256: index.pointer.sha256 } };
}

export async function archiveSelectionCurrent(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  pin?: ArchivePin,
) {
  invariant(
    !pin || (project.journalEventRewriteRevision ?? 0) === pin.rewriteRevision,
    'WORK_STALE',
    archiveChanged,
  );
  if (pin?.indexedRevision !== undefined)
    return (
      project.planningArchiveIndexed === true &&
      pin.indexedRevision === (project.planningArchiveEventRevision ?? 0)
    );
  const [last] = project.journalRevision ? await eventSegments(ctx, project._id).order('desc').take(1) : [];
  const current = last ? segmentEntry(last).pin : null;
  const selected = pin?.frontier ?? null;
  if (canonicalPayload(current) === canonicalPayload(selected)) return true;
  invariant(!selected || (current && current.from > selected.from), 'WORK_STALE', archiveChanged);
  return false;
}

async function selection(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    itemId: string;
    ids: string[];
  },
) {
  const project = await ctx.db.get(input.projectId);
  invariant(project && !project.removal, 'WORK_STALE', archiveChanged);
  const row = await receiptRow(ctx, input.projectId, key(input.operationId));
  const request = digest(canonicalPayload([input.itemId, input.ids]));
  const rewriteRevision = project.journalEventRewriteRevision ?? 0;
  const indexedRevision = project.planningArchiveIndexed
    ? (project.planningArchiveEventRevision ?? 0)
    : undefined;
  const prior = row && (JSON.parse(row.envelope) as SelectionProgress);
  // A legacy receipt never has this fence. Its cursor pinned the entire journal revision.
  const progress: SelectionProgress =
    prior?.request === request &&
    prior.rewriteRevision === rewriteRevision &&
    prior.indexedRevision === indexedRevision
      ? prior
      : {
          request,
          rewriteRevision,
          frontier: null,
          ...(indexedRevision === undefined
            ? {}
            : { indexedRevision, indexedAfter: { target: 0, after: null } }),
          done: false,
          selected: { rows: [], decisions: [], created: null, creates: false },
        };
  return { project, row, progress };
}

export const resume = internalQuery({
  args,
  returns: v.any(),
  handler: async (ctx, input): Promise<SelectionProgress> => {
    const { project, progress } = await selection(ctx, input);
    if (progress.done && !(await archiveSelectionCurrent(ctx, project, progress)))
      return { ...progress, done: false };
    return progress;
  },
});

/** The event publisher advances one durable revision-ordered frontier, including across fragmented pages. */
export const page = internalQuery({
  args: {
    projectId: identity.projectId,
    after: frontier,
    indexed: v.optional(v.object({ ids: v.array(v.string()), cursor: archiveTargetCursor })),
  },
  returns: v.any(),
  handler: async (
    ctx,
    input,
  ): Promise<{
    entries: ReturnType<typeof segmentEntry>[];
    done: boolean;
    indexed?: { itemId: string | null; target: number; next: TargetCursor };
  }> => {
    if (input.indexed) {
      const page = await archivedTargetPage(
        ctx,
        input.projectId,
        input.indexed.ids.map(itemId => ({ kind: 'events', itemId })),
        input.indexed.cursor,
      );
      return {
        entries: (await archivedSegmentRows(ctx, input.projectId, page.keys)).map(segmentEntry),
        done: page.done,
        indexed: { itemId: page.itemId, target: page.target, next: page.next },
      };
    }
    const page = await eventSegments(ctx, input.projectId, input.after?.from).paginate({
      cursor: null,
      numItems: 16,
      maximumRowsRead: 16,
      maximumBytesRead: 256 * 1024,
    });
    return { entries: page.page.map(segmentEntry), done: page.isDone };
  },
});

/** The frontier names the last verified segment. The rewrite fence covers every earlier pointer and fragment. */
export const checkpoint = internalMutation({
  args: {
    ...args,
    expected: archivePin,
    next: frontier,
    indexed: v.optional(v.object({ expected: archiveTargetCursor, next: archiveTargetCursor })),
    done: v.boolean(),
    selected: archiveSelectionValues,
  },
  returns: v.any(),
  handler: async (ctx, input): Promise<SelectionProgress> => {
    const { row, progress } = await selection(ctx, input);
    invariant(progress.rewriteRevision === input.expected.rewriteRevision, 'WORK_STALE', archiveChanged);
    if (
      progress.indexedRevision !== input.expected.indexedRevision ||
      canonicalPayload(progress.indexedAfter ?? null) !== canonicalPayload(input.indexed?.expected ?? null) ||
      canonicalPayload(progress.frontier) !== canonicalPayload(input.expected.frontier)
    )
      return progress;
    const previous = progress.selected;
    const created = input.selected.created;
    const next: SelectionProgress = {
      request: progress.request,
      rewriteRevision: progress.rewriteRevision,
      frontier: input.next,
      ...(input.indexed
        ? { indexedRevision: progress.indexedRevision!, indexedAfter: input.indexed.next }
        : {}),
      done: input.done,
      selected: {
        rows: [...previous.rows, ...input.selected.rows],
        decisions: [...previous.decisions, ...input.selected.decisions],
        created: created === null ? previous.created : Math.min(previous.created ?? created, created),
        creates: previous.creates || input.selected.creates,
      },
    };
    const envelope = canonicalPayload(next);
    const fields = {
      projectId: input.projectId,
      operationId: key(input.operationId),
      hash: digest(envelope),
      envelope,
    };
    if (row) await ctx.db.replace(row._id, fields);
    else await ctx.db.insert('projectJournalReceipts', fields);
    return next;
  },
});

export async function clearArchiveSelection(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  const row = await receiptRow(ctx, projectId, key(operationId));
  if (row) await ctx.db.delete(row._id);
}

export const discard = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    await clearArchiveSelection(ctx, input.projectId, input.operationId);
    return null;
  },
});
