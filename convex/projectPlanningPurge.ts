// SPDX-License-Identifier: Apache-2.0
// The Item purge executor (Item 4c9e961e, purge Lane 2). `run` is internal: the 30-day timer and the owner's early
// removal (purge Lane 4) call it. Order: read-only preflight; selection of every journal row of the Item (all its
// ids, notes included; refused above PURGE_ROW_LIMIT); the atomic first step (purge command with the row list and
// the tombstone, plus this purge's progress entry); paged redaction of every store; the completeness check; and
// only then `purgedAt`. Every step is idempotent, so a purge that stops anywhere resumes by running again with the
// same operation id, also after an index rebuild (the index steps work on the selected generation, and `finish`
// refuses when the generation the check read is no longer selected).
import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { PURGE_ROW_LIMIT } from '../src/work-planning-types';
import { executeCommand } from './projectWorkCommand';
import {
  BASE_BLOCK,
  baseRevision,
  DISPLAY_BLOCK,
  displaySnapshots,
  purgeJournalTables,
  purgeIntentChain,
  purgeTarget,
  selectRows,
  selectEventRows,
} from './projectPlanningPurgeSelect';
import {
  partitionsOf,
  purgeRevision,
  purgeStep,
  purgeSteps,
  type ItemPurge,
  type PurgeStep,
} from './projectPlanningPurgeRedact';

import { selectedGeneration } from './projectWorkIndexStore';
import { pendingIntentArchives } from './projectJournalArchivePlan';
import { journalEnabled } from './projectJournalMaintenance';
import { clearArchiveSelection } from './projectPlanningPurgeArchiveSelection';

const LATE_ROW_BLOCK =
  'A note reached this Item’s Intent after its purge began; its words are not on the purge’s list, so the purge stays open (not done). Nothing more was purged.';
/** Finished purges kept on the project (newest first); unfinished ones always stay. */
const KEPT_FINISHED = 20;
const selection = v.object({
  ids: v.array(v.string()),
  created: v.number(),
  rows: v.array(v.array(v.string())),
  decisions: v.array(v.array(v.string())),
  journalRevision: v.number(),
  through: v.object({ projectWorkEvents: v.number(), projectHostedRecordBodies: v.number() }),
});
const stepName = v.union(...purgeSteps.map(step => v.literal(step)));

async function entry(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) {
  const project = await ctx.db.get(projectId);
  const purge = project?.itemPurges?.find(item => item.operationId === operationId);
  invariant(purge, 'NOT_FOUND', 'This purge has not started.');
  return purge;
}

export const status = internalQuery({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.any(),
  handler: async (ctx, { projectId, operationId }) => {
    const project = await ctx.db.get(projectId);
    const purge = project?.itemPurges?.find(item => item.operationId === operationId);
    return purge && project?.journalRevision && purge.purgedAt === undefined && !purge.segmentSweep
      ? { ...purge, segmentSweep: { after: null, done: false } }
      : (purge ?? null);
  },
});

/** The atomic first step: no row of the Item was appended after the selection read (else WORK_STALE: select again),
 * then the purge command and tombstone (one mutation, executeCommand) and this purge's progress entry. A replay of
 * the same operation returns the recorded entry. */
export const begin = internalMutation({
  args: { projectId: v.id('hostedProjects'), itemId: v.string(), operationId: v.string(), selection },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    if (project.itemPurges?.some(item => item.operationId === input.operationId)) return null;
    invariant(
      (project.journalRevision ?? 0) === input.selection.journalRevision,
      'WORK_STALE',
      'The archived Work journal changed while selecting the Item. Run the same purge again to resume.',
    );
    const target = await purgeTarget(ctx, input.projectId, input.itemId);
    invariant(input.selection.created > baseRevision(project, target.generation), 'BAD_ARGUMENT', BASE_BLOCK);
    // The store's Intent chain and every reader's purged-version check start from the Item id (purgedIntentKeys).
    invariant(
      !target.intentId || target.intentId === target.historyId,
      'BAD_ARGUMENT',
      'This Item’s Intent has an id of its own; a purge cannot follow it yet. Nothing was purged.',
    );
    // The selection walked the journal under these ids; a new alias since then would hide its earlier rows.
    invariant(
      JSON.stringify(target.ids) === JSON.stringify(input.selection.ids),
      'WORK_STALE',
      'The Item changed while its rows were selected. Select again.',
    );
    for (const table of purgeJournalTables) {
      let after = input.selection.through[table];
      for (;;) {
        const tail = await selectRows(ctx, { projectId: input.projectId, table, ids: target.ids, after });
        invariant(
          !tail.rows.length,
          'WORK_STALE',
          'The Item changed while its rows were selected. Select again.',
        );
        if (tail.done) break;
        after = tail.after;
      }
    }
    const intentKeys = await purgeIntentChain(ctx, input.projectId, target.historyId, target.partition);
    invariant(
      !(await pendingIntentArchives(ctx, input.projectId, intentKeys)).length,
      'WORK_STALE',
      'The journal is archiving one of this Item’s Intent versions. Run the same purge again to resume.',
    );
    const command = {
      action: 'purge-planning-item' as const,
      operationId: input.operationId,
      itemId: target.historyId,
      kind: target.item.kind,
      expectedVersion: target.item.version,
      // The Deleted version's time: the 30-day window (purge Lane 4) counts from it.
      deletedAt: target.item.at,
      rows: input.selection.rows,
    };
    await executeCommand(
      ctx,
      { projectId: input.projectId, operationId: input.operationId, command: JSON.stringify(command) },
      project.owner,
      { purge: true },
    );
    const started: ItemPurge = {
      operationId: input.operationId,
      itemId: target.historyId,
      ids: target.ids,
      ...(target.intentId ? { intentId: target.intentId } : {}),
      intentKeys,
      version: target.item.version,
      decisions: input.selection.decisions,
      rows: input.selection.rows.length,
      created: input.selection.created,
      startedAt: Date.now(),
      ...(project.journalRevision || journalEnabled() ? { segmentSweep: { after: null, done: false } } : {}),
    };
    if (input.selection.journalRevision) await clearArchiveSelection(ctx, input.projectId, input.operationId);
    const others = project.itemPurges ?? [];
    const finished = others.filter(item => item.purgedAt !== undefined).slice(0, KEPT_FINISHED - 1);
    await ctx.db.patch(input.projectId, {
      itemPurges: [started, ...others.filter(item => item.purgedAt === undefined), ...finished],
    });
    return null;
  },
});

/** One page of one redaction step. */
export const redact = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    step: stepName,
    after: v.union(v.string(), v.null()),
  },
  returns: v.object({ changes: v.number(), after: v.union(v.string(), v.null()) }),
  handler: async (ctx, input) => {
    const purge = await entry(ctx, input.projectId, input.operationId);
    return purgeStep(ctx, { ...input, purge, step: input.step as PurgeStep }, true);
  },
});

/** The completeness check, one page: what that redaction page would still change (0 when the page is clean). */
export const check = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    step: stepName,
    after: v.union(v.string(), v.null()),
  },
  returns: v.object({
    changes: v.number(),
    after: v.union(v.string(), v.null()),
    generationId: v.string(),
    partitions: v.string(),
  }),
  handler: async (ctx, input) => {
    const purge = await entry(ctx, input.projectId, input.operationId);
    const project = (await ctx.db.get(input.projectId))!;
    const generation = await selectedGeneration(ctx, project);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
    const page = await purgeStep(ctx, { ...input, purge, step: input.step as PurgeStep }, false);
    return {
      ...page,
      generationId: generation._id,
      partitions: (await partitionsOf(ctx, input.projectId)).join(','),
    };
  },
});

/** Marks the purge done, only when the check found nothing left on the generation that is still selected. */
export const finish = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    generationId: v.string(),
    partitions: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, input) => {
    const purge = await entry(ctx, input.projectId, input.operationId);
    if (purge.purgedAt !== undefined) return purge.purgedAt;
    const project = (await ctx.db.get(input.projectId))!;
    invariant(
      !project.journalRevision || purge.segmentSweep?.done,
      'WORK_STALE',
      'The journal segment sweep has not finished. Run the purge again to resume.',
    );
    const generation = await selectedGeneration(ctx, project);
    invariant(
      generation?._id === input.generationId,
      'WORK_STALE',
      'The Work index changed during the completeness check. Run the purge again to resume.',
    );
    // Every record partition the check walked is still the whole set, and no build is writing a new one.
    const generations = await ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project_and_backup_and_revision_and_format', q => q.eq('projectId', input.projectId))
      .take(65);
    invariant(
      (await partitionsOf(ctx, input.projectId)).join(',') === input.partitions &&
        !generations.some(item => item.status === 'building'),
      'WORK_STALE',
      'The Work index changed during the completeness check. Run the purge again to resume.',
    );
    // A stored base cut since begin (a record-detail migration) may hold the Item's words again.
    invariant(
      purge.created === undefined || purge.created > baseRevision(project, generation!),
      'BAD_ARGUMENT',
      BASE_BLOCK,
    );
    // Copies the redaction steps cannot reach keep the purge open (never done with words left).
    invariant(!(await displaySnapshots(ctx, input.projectId)), 'BAD_ARGUMENT', DISPLAY_BLOCK);
    // A note on the Item's Intent is still accepted after the first step (refusing it would cost every note write a
    // read). Its row is not on the purge's list, so no reader would accept it purged: the purge never finishes over it.
    const since = await purgeRevision(ctx, input.projectId, input.operationId);
    for (const table of purgeJournalTables)
      for (let after = since; ;) {
        const tail = await selectRows(ctx, { projectId: input.projectId, table, ids: purge.ids, after });
        invariant(!tail.rows.length, 'WORK_STALE', LATE_ROW_BLOCK);
        if (tail.done) break;
        after = tail.after;
      }
    const purgedAt = Date.now();
    await ctx.db.patch(input.projectId, {
      planningPurgeRevision: (project.planningPurgeRevision ?? 0) + 1,
      // A finished entry keeps no working decisions or archive cursor on later project reads.
      itemPurges: project.itemPurges!.map(item => {
        if (item.operationId !== input.operationId) return item;
        const finished = { ...item, decisions: [], purgedAt };
        delete finished.intentKeys;
        delete finished.segmentSweep;
        return finished;
      }),
    });
    return purgedAt;
  },
});

/** Run (or resume) the purge of one Deleted Item. Returns the progress entry; `purgedAt` is set only when done. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), itemId: v.string(), operationId: v.string() },
  returns: v.any(),
  handler: async (ctx, input): Promise<ItemPurge | null> => {
    const ref = internal.projectPlanningPurge;
    const id = { projectId: input.projectId, operationId: input.operationId };
    let purge: ItemPurge | null = await ctx.runQuery(ref.status, id);
    if (!purge) {
      const preflightArgs = { projectId: input.projectId, itemId: input.itemId };
      const preflight = await ctx.runQuery(internal.projectPlanningPurgeSelect.preflight, preflightArgs);
      invariant(!preflight.blocked, 'BAD_ARGUMENT', preflight.blocked ?? '');
      for (const pending of preflight.pendingArchives)
        if (pending.availableAt <= Date.now())
          await ctx.runAction(internal.projectJournalRun.pack, { ...pending.input, discardExpired: true });
      const rows: [number, string, string][] = [],
        decisions: string[][] = [];
      const through = { projectWorkEvents: -1, projectHostedRecordBodies: -1 };
      let created: number | null = null,
        creates = false;
      for (const table of purgeJournalTables)
        for (;;) {
          const page = await ctx.runQuery(internal.projectPlanningPurgeSelect.selectPage, {
            projectId: input.projectId,
            table,
            ids: preflight.ids,
            after: through[table],
          });
          rows.push(
            ...page.rows.map(
              (row: { revision: number; operationId: string; digest: string }) =>
                [row.revision, row.operationId, row.digest] as [number, string, string],
            ),
          );
          decisions.push(...page.decisions);
          if (page.created !== null) created = Math.min(created ?? page.created, page.created);
          creates ||= page.creates;
          through[table] = page.after;
          invariant(
            rows.length <= PURGE_ROW_LIMIT,
            'BAD_ARGUMENT',
            `This Item has more than ${PURGE_ROW_LIMIT} Work rows; a purge removes at most ${PURGE_ROW_LIMIT}.`,
          );
          if (page.done) break;
        }
      if (preflight.journalRevision) {
        const archived: ReturnType<typeof selectEventRows> = await ctx.runAction(
          internal.projectPlanningPurgeSegmentRun.select,
          { ...input, ids: preflight.ids, journalRevision: preflight.journalRevision },
        );
        for (const row of archived.rows) rows.push([row.revision, row.operationId, row.digest]);
        decisions.push(...archived.decisions);
        if (archived.created !== null) created = Math.min(created ?? archived.created, archived.created);
        creates ||= archived.creates;
      }
      const validBase = creates && created !== null && created > preflight.initialRevision;
      if (preflight.journalRevision && (rows.length > PURGE_ROW_LIMIT || !validBase))
        await ctx.runMutation(internal.projectPlanningPurgeArchiveSelection.discard, id);
      invariant(
        rows.length <= PURGE_ROW_LIMIT,
        'BAD_ARGUMENT',
        `This Item has more than ${PURGE_ROW_LIMIT} Work rows; a purge removes at most ${PURGE_ROW_LIMIT}.`,
      );
      // An Item with no creation row after the base checkpoint is in the stored archive: a rebuild would read it.
      // Every row of the Item, its Intent's included, must come after the stored base, and the put that created it
      // must be there: otherwise a base archive holds some of its words and a rebuild reads them again.
      invariant(validBase, 'BAD_ARGUMENT', BASE_BLOCK);
      rows.sort((a, b) => a[0] - b[0]);
      await ctx.runMutation(ref.begin, {
        ...input,
        selection: {
          ids: preflight.ids,
          created: created!,
          rows: rows.map(([, operationId, digest]) => [operationId, digest]),
          decisions,
          through,
          journalRevision: preflight.journalRevision,
        },
      });
      purge = await ctx.runQuery(ref.status, id);
    }
    if (purge!.purgedAt !== undefined) return purge;
    // Redact, then check; a page the check still finds dirty (a rebuild landed in between) gets another round.
    for (let round = 0; round < 3; round++) {
      for (const step of purgeSteps) {
        let after: string | null = null;
        do after = (await ctx.runMutation(ref.redact, { ...id, step, after })).after;
        while (after !== null);
      }
      if (purge!.segmentSweep && !purge!.segmentSweep.done)
        await ctx.runAction(internal.projectPlanningPurgeSegmentRun.run, id);
      let dirty = 0,
        generationId: string | undefined,
        partitions: string | undefined;
      for (const step of purgeSteps) {
        let after: string | null = null;
        do {
          const page: { changes: number; after: string | null; generationId: string; partitions: string } =
            await ctx.runQuery(ref.check, { ...id, step, after });
          dirty += page.changes;
          invariant(
            !generationId || generationId === page.generationId,
            'WORK_STALE',
            'The Work index changed.',
          );
          generationId = page.generationId;
          invariant(!partitions || partitions === page.partitions, 'WORK_STALE', 'The Work index changed.');
          partitions = page.partitions;
          after = page.after;
        } while (after !== null);
      }
      if (dirty === 0) {
        await ctx.runMutation(ref.finish, { ...id, generationId: generationId!, partitions: partitions! });
        return ctx.runQuery(ref.status, id);
      }
    }
    return ctx.runQuery(ref.status, id);
  },
});
