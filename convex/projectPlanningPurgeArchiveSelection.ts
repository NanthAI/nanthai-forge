// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import type { Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';
import { internalQuery, internalMutation } from './server';
import { receiptRow } from './projectJournalMaintenance';
import type { selectEventRows } from './projectPlanningPurgeSelect';

export type ArchiveSelection = ReturnType<typeof selectEventRows>;
type SelectionProgress = {
  request: string;
  cursor: string | null;
  done: boolean;
  selected: ArchiveSelection;
};

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
const args = {
  ...identity,
  itemId: v.string(),
  ids: v.array(v.string()),
  journalRevision: v.number(),
};
const empty = (): ArchiveSelection => ({ rows: [], decisions: [], created: null, creates: false });
const key = (operationId: string) => `purge-selection:${operationId}`;

async function selection(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    itemId: string;
    ids: string[];
    journalRevision: number;
  },
) {
  const project = await ctx.db.get(input.projectId);
  invariant(
    project && !project.removal && (project.journalRevision ?? 0) === input.journalRevision,
    'WORK_STALE',
    'The archived Work journal changed while selecting the Item. Run the same purge again to resume.',
  );
  const row = await receiptRow(ctx, input.projectId, key(input.operationId));
  const request = digest(canonicalPayload([input.itemId, input.ids, input.journalRevision]));
  const prior = row && (JSON.parse(row.envelope) as SelectionProgress);
  const progress: SelectionProgress =
    prior?.request === request ? prior : { request, cursor: null, done: false, selected: empty() };
  return { row, progress };
}

export const resume = internalQuery({
  args,
  returns: v.any(),
  handler: async (ctx, input): Promise<SelectionProgress> => (await selection(ctx, input)).progress,
});

/** Checkpoint only ids, digests and the next cursor. The tombstone transaction consumes the receipt. */
export const checkpoint = internalMutation({
  args: {
    ...args,
    expected: v.union(v.string(), v.null()),
    next: v.union(v.string(), v.null()),
    done: v.boolean(),
    selected: v.object({
      rows: v.array(
        v.object({ operationId: v.string(), revision: v.number(), digest: v.string(), request: v.string() }),
      ),
      decisions: v.array(v.array(v.string())),
      created: v.union(v.number(), v.null()),
      creates: v.boolean(),
    }),
  },
  returns: v.any(),
  handler: async (ctx, input): Promise<SelectionProgress> => {
    const { row, progress } = await selection(ctx, input);
    if (progress.done || progress.cursor !== input.expected) return progress;
    const previous = progress.selected;
    const created = input.selected.created;
    const next: SelectionProgress = {
      request: progress.request,
      cursor: input.next,
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
