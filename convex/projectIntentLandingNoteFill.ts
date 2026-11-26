// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { recordHead } from './projectHostedRecords';
import { commandPayloadRows, commandValues } from './projectWorkCommandRows';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { readsStore, storeItem } from './projectWorkStoreReads';
import { internalMutation, internalQuery } from './server';
import { invariant } from '../src/errors';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { PlanningItem } from '../src/work-planning-types';

const pageRows = 64;
const pageReadBytes = 512 * 1024;
const pageReadDocs = 192;
const bytesPerNote = 1_500;
const projectArgs = { projectId: v.id('hostedProjects') };
const noteId = v.id('projectIntentLandingNotes');
const first = v.union(noteId, v.null());
const cursor = v.union(v.string(), v.null());
const rowLimit = v.optional(v.number());
const sample = v.object({ noteId, receiptId: v.string() });
type Note = Doc<'projectIntentLandingNotes'>;
type ProjectId = Id<'hostedProjects'>;
type Evidence = { noteId: Note['_id']; receiptId: string };

function projectNotes(ctx: QueryCtx, projectId: ProjectId, missing: boolean) {
  invariant(
    process.env.CONVEX_CLOUD_URL === 'https://benevolent-wildebeest-974.convex.cloud',
    'PROJECT_UNAVAILABLE',
    'Landing note Item backfill runs only on Forge dev.',
  );
  return ctx.db.query('projectIntentLandingNotes').withIndex('by_project_and_item_and_at', q => {
    const range = q.eq('projectId', projectId);
    return missing ? range.eq('itemId', undefined) : range;
  });
}

async function activeProject(ctx: QueryCtx, projectId: ProjectId) {
  const project = await ctx.db.get(projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an active dev project.');
  return project;
}

function checkRowLimit(maxRows: number) {
  invariant(
    Number.isInteger(maxRows) && maxRows >= 1 && maxRows <= pageRows,
    'BAD_ARGUMENT',
    'Request at most 64 landing notes per page.',
  );
}

async function checkReadBudget(ctx: QueryCtx) {
  const measured = await ctx.meta?.getTransactionMetrics?.();
  invariant(
    !measured || (measured.documentsRead.used <= pageReadDocs && measured.bytesRead.used <= pageReadBytes),
    'WORK_STALE',
    'Landing note provenance exceeded the page read budget. Resume with a smaller maxRows.',
  );
}

function memo<T>(read: (id: string) => Promise<T>) {
  const values = new Map<string, Promise<T>>();
  return (id: string) => {
    const value = values.get(id) ?? read(id);
    values.set(id, value);
    return value;
  };
}

function bindings(ctx: QueryCtx, projectId: ProjectId) {
  let project: Promise<Doc<'hostedProjects'>> | undefined;
  const currentProject = () => (project ??= activeProject(ctx, projectId));
  const intent = memo(id => recordHead(ctx, projectId, 'intent', id));
  const lane = memo(id => recordHead(ctx, projectId, 'lane', id));
  const candidate = memo(id => recordHead(ctx, projectId, 'candidate', id));
  const receipt = memo(async receiptId => {
    const row = await acceptanceRow(ctx, { projectId, receiptId });
    invariant(row, 'WORK_STALE', `Landing note acceptance receipt ${receiptId} is unavailable.`);
    const value = JSON.parse(row.value) as HostedAcceptance;
    const candidateId = value.memberCandidate?.id ?? value.candidate?.id;
    invariant(candidateId, 'WORK_STALE', `Acceptance receipt ${receiptId} has no Candidate identity.`);
    return candidateId;
  });
  const item = memo(async (id): Promise<PlanningItem | null> => {
    const owner = await currentProject();
    if (readsStore(owner, 'planningItems'))
      return storeItem(ctx, projectId, id) as Promise<PlanningItem | null>;
    if (!owner.work) return null;
    const generation = await selectedGeneration(ctx, owner);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Select a ready Work index before filling notes.');
    const partition = recordPartition(generation);
    const rows = [await record(ctx, partition, 'planningItems', id)];
    await commandPayloadRows(rows, keys =>
      Promise.all(keys.map(key => record(ctx, partition, key.collection, key.key))),
    );
    return commandValues(rows, 'planningItems')[0] ?? null;
  });
  const surviving = memo(async (id): Promise<string | null> => {
    const seen = new Set<string>();
    for (;;) {
      invariant(
        !seen.has(id) && seen.size < 20,
        'WORK_STALE',
        'The Item duplicate chain could not be resolved.',
      );
      seen.add(id);
      const value = await item(id);
      await checkReadBudget(ctx);
      if (!value || (value.kind ?? 'issue') !== 'issue' || value.purged) return null;
      const targets = (value.relations ?? []).filter(relation => relation.kind === 'duplicate-of');
      invariant(targets.length <= 1, 'WORK_STALE', 'The Item names more than one surviving duplicate.');
      if (!targets[0]) return value.status === 'deleted' ? null : id;
      id = targets[0].id;
    }
  });
  return {
    currentProject,
    async resolve(note: Note) {
      const bound = (await intent(note.intentId))?.planningItemId;
      if (bound) return { itemId: bound, recovered: false };

      // A revert is attributed to the original landing's work. Its own acceptance stays as History evidence.
      const ownCandidate = await receipt(note.receiptId);
      const source = await candidate(note.revertOf ? await receipt(note.revertOf) : ownCandidate);
      const references = new Set([note.intentId]);
      for (const head of [source, ...(await Promise.all(note.laneIds.map(lane)))]) {
        if (!head) continue;
        if (head.planningItemId) references.add(head.planningItemId);
        if (head.parent) {
          references.add(head.parent);
          const binding = (await intent(head.parent))?.planningItemId;
          if (binding) references.add(binding);
        }
      }
      const targets = new Set<string>();
      for (const reference of references) {
        const target = await surviving(reference);
        if (target) targets.add(target);
      }
      invariant(targets.size <= 1, 'WORK_STALE', `Landing note ${note._id} names multiple surviving Items.`);
      const [itemId] = targets;
      return { itemId: itemId ?? null, recovered: Boolean(itemId) };
    },
  };
}

/** Count all notes for the orphan fraction. Classify only rows missing their Item binding. */
export const count = internalQuery({
  args: { ...projectArgs, cursor, maxRows: rowLimit },
  returns: v.object({
    notes: v.number(),
    rows: v.number(),
    estimatedBytes: v.number(),
    boundSamples: v.array(v.string()),
    recoverable: v.array(sample),
    orphans: v.array(sample),
    next: cursor,
  }),
  handler: async (ctx, { projectId, cursor, maxRows = pageRows }) => {
    checkRowLimit(maxRows);
    const page = await projectNotes(ctx, projectId, false).paginate({
      cursor,
      numItems: maxRows,
      maximumRowsRead: maxRows,
      maximumBytesRead: 256 * 1024,
    });
    const { resolve } = bindings(ctx, projectId);
    const boundSamples = new Set<string>();
    const recoverable: Evidence[] = [];
    const orphans: Evidence[] = [];
    let rows = 0;
    await checkReadBudget(ctx);
    for (const note of page.page) {
      if (note.itemId !== undefined) continue;
      rows++;
      const binding = await resolve(note);
      await checkReadBudget(ctx);
      const evidence = { noteId: note._id, receiptId: note.receiptId };
      if (binding.recovered) recoverable.push(evidence);
      else if (!binding.itemId) orphans.push(evidence);
      else if (boundSamples.size < 5) boundSamples.add(note.receiptId);
    }
    return {
      notes: page.page.length,
      rows,
      estimatedBytes: rows * bytesPerNote,
      boundSamples: [...boundSamples],
      recoverable,
      orphans,
      next: page.isDone ? null : page.continueCursor,
    };
  },
});

/** A null first row verifies that no hot or archived reference is missing its binding. */
export const remaining = internalQuery({
  args: projectArgs,
  returns: first,
  handler: async (ctx, { projectId }) => {
    const [row] = await projectNotes(ctx, projectId, true).take(1);
    return row?._id ?? null;
  },
});

/** Each processed row leaves the index range. A lost reply can retry the original first-row pin. */
export const fill = internalMutation({
  args: {
    ...projectArgs,
    first: noteId,
    maxRows: rowLimit,
    deleteOrphans: v.optional(v.array(noteId)),
  },
  returns: v.object({ patched: v.number(), recovered: v.number(), deleted: v.number(), stale: v.boolean() }),
  handler: async (ctx, { projectId, first, maxRows = pageRows, deleteOrphans = [] }) => {
    checkRowLimit(maxRows);
    const { resolve, currentProject } = bindings(ctx, projectId);
    const approved = new Set(deleteOrphans);
    const updates: Array<{ noteId: Note['_id']; itemId: string | null }> = [];
    let recovered = 0;
    for await (const note of projectNotes(ctx, projectId, true)) {
      if (!updates.length && note._id !== first) break;
      const binding = await resolve(note);
      await checkReadBudget(ctx);
      invariant(
        binding.itemId || approved.has(note._id),
        'WORK_STALE',
        `Orphan landing note ${note._id} was not in the census. Report the stopped page to the lead.`,
      );
      if (binding.recovered) recovered++;
      updates.push({ noteId: note._id, itemId: binding.itemId });
      if (updates.length === maxRows) break;
    }
    if (updates.length) {
      await currentProject();
      await checkReadBudget(ctx);
    }
    let deleted = 0;
    for (const { noteId, itemId } of updates) {
      if (itemId) await ctx.db.patch(noteId, { itemId });
      else {
        // An archived note's row is its sole reference; keep the shared capsule and the acceptance receipt.
        await ctx.db.delete(noteId);
        deleted++;
      }
    }
    return { patched: updates.length - deleted, recovered, deleted, stale: updates.length === 0 };
  },
});
