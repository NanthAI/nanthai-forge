// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { JournalNeeded, journalReadReply } from './projectJournalStore';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { PaginationOptions } from 'convex/server';
import type { Infer } from 'convex/values';
import { splitRecordTable } from './projectWorkRecordTables';
import { findWorkEvent } from './projectWorkEventStore';
import { likelyPlanningDuplicates } from './projectHostedPlanningSearch';
import { needsFix } from '../src/culprit-bisect';
import { githubMirrorStatus } from './projectGithubMirrorStatus.idle';
import { hostedRecordValue } from './hostedRecordValue';
import { hostedPaths } from '../src/hosted-paths';
import { generationHead } from './projectWorkHead';
import { cockpitSummary, hostedMain } from './projectWorkIndexSummary';
import { effectivePolicy } from '../src/autonomy-policy';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query } from './cliServer';
import { logIoAttribution } from './ioAttribution';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { invariant } from '../src/errors';
import { hasWriteRole } from './projectRole';
import { report } from './errors';
import { actorSummary } from './projectActorNames';
import {
  initiativeCloseHistory,
  planningHistoryBudget,
  planningHistoryResult,
  planningTimesFallbackReporter,
  withPlanningTimes,
} from './projectPlanningHistory';
import { countedInitiative, planningFilter, planningPage } from './projectPlanningList';
import { readsStore, storeItem, storeItemRow, storePage } from './projectWorkStoreReads';
import type { PlanningTimesRead } from './projectPlanningTimes';
import { linkedLandingCursor, withLandingNotes } from './projectWorkIndexLandingNotes';
import { readRollupCatchup } from './projectPlanRollupCatchupStore';
const selection = {
  projectId: v.id('hostedProjects'),
  generationId: v.optional(v.id('projectWorkGenerations')),
};
const identity = {
  generationId: v.union(v.id('projectWorkGenerations'), v.null()),
  revision: v.union(v.number(), v.null()),
};
export const workspace = query({
  args: {
    projectId: v.id('hostedProjects'),
    planningDuplicateText: v.optional(v.string()),
    planningRollup: v.optional(v.literal(true)),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { projectId, planningDuplicateText, planningRollup }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, projectId, user.subject),
        generation = await selectedGeneration(ctx, project);
      if (!generation) return null;
      // Flip 5 (Issue 0695ab24): no read of the per-project Work head, so a journal write does not re-run
      // this query in every open tab. Counts are the generation's; pages that need live ones count their
      // loaded rows. A collection the generation had no rows of is probed once (its first row only).
      const metadata = JSON.parse(generation.metadata) as { counts?: Record<string, number> };
      const counts = { ...metadata.counts };
      for (const collection of ['sourcePins', 'landingEntries', 'landingBatches'])
        if (counts[collection] === undefined) {
          const [first] = await ctx.db
            .query(splitRecordTable(collection))
            .withIndex('by_generation_and_collection_and_position', q =>
              q.eq('generationId', recordPartition(generation)).eq('collection', collection),
            )
            .take(1);
          if (first) counts[collection] = 1;
        }
      const backup = await ctx.db.get(generation.backupId);
      invariant(backup?.projectId === projectId, 'PROJECT_UNAVAILABLE', 'Select this project’s source.');
      const owner = project.owner === user.subject;
      const contributor = owner || (await hasWriteRole(ctx, project, user.subject));
      return JSON.stringify({
        ...hostedPaths({ ...metadata, counts }),
        ...(planningDuplicateText === undefined
          ? {}
          : { likelyDuplicates: await likelyPlanningDuplicates(ctx, project, planningDuplicateText) }),
        ...(planningRollup
          ? { rollupCatchup: await readRollupCatchup(ctx, project, recordPartition(generation)) }
          : {}),
        autonomyPolicy: effectivePolicy(project),
        ...(project.needsFix ? { needsFix: needsFix(project) } : {}),
        githubMirror: await githubMirrorStatus(ctx, project),
        generationId: generation._id,
        planningFilteredReads: generation.planningSearchVersion === 2,
        backupId: generation.backupId,
        backupDigest: backup.digest,
        sourceTransport: backup.transport,
        sourceRevision: generation.initialRevision,
        name: project.name,
        key: project.key,
        projectId,
        actor: user.subject,
        capabilities: {
          indexedWorkReads: true,
          recentSummaryPages: true,
          selectedRecordPayload: true,
          pagedHistory: true,
          owner,
          editableIntentIds: [],
          intent: contributor,
          note: contributor,
          intentStatus: contributor,
          hostedChannels: owner,
          planning: owner,
          execution: 'local',
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const records = query({
  args: {
    ...selection,
    collection: v.string(),
    planningFilter: v.optional(planningFilter),
    counts: v.optional(v.boolean()),
    initiativeProgress: v.optional(v.literal(true)),
    planningHistory: v.optional(v.union(v.literal(true), v.number())),
    memberCommentsOnly: v.optional(v.literal(true)),
    newestFirst: v.optional(v.boolean()),
    parentId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    ...identity,
    journalHistory: v.optional(v.literal(true)),
    viewVersion: v.optional(v.string()),
    coverage: v.optional(v.string()),
    history: v.optional(planningHistoryResult),
    // State names are dynamic record keys: a literal object validator cannot name `in-progress`.
    counts: v.optional(v.record(v.string(), v.number())),
    ...paginationResultValidator(v.object({ id: v.string(), position: v.number(), value: v.string() }))
      .fields,
  }),
  handler: async (ctx, input) => {
    const mode = input.counts
      ? 'counts'
      : input.collection === 'planningComments'
        ? 'comments'
        : input.collection === 'planningItems'
          ? 'list'
          : 'other';
    try {
      return await journalWorkRecordsRead(ctx, input);
    } finally {
      await logIoAttribution(ctx, `work-index/${mode}`);
    }
  },
});
export const detail = query({
  args: {
    ...selection,
    collection: v.string(),
    id: v.string(),
    inlineItemOnly: v.optional(v.literal(true)),
    planningHistory: v.optional(v.literal(true)),
  },
  returns: v.object({
    ...identity,
    value: v.union(v.string(), v.null()),
    deferred: v.optional(v.literal(true)),
    editable: v.boolean(),
    intentPin: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, input.projectId, user.subject),
        generation = await selectedGeneration(ctx, project);
      if (!generation || (input.generationId && input.generationId !== generation._id))
        return { generationId: null, revision: null, value: null, editable: false, intentPin: null };
      const planningHistory =
        input.planningHistory &&
        input.collection === 'planningItems' &&
        (await readProjectRole(ctx, project, user.subject));
      const decorate = (value: string, pinned?: PlanningTimesRead) =>
        planningHistory
          ? withPlanningTimes(
              ctx,
              project,
              recordPartition(generation),
              value,
              planningHistoryBudget(),
              pinned,
              project.workStore === 'records' ? planningTimesFallbackReporter() : undefined,
            )
          : value;
      if (input.collection === 'planningItems' && readsStore(project, input.collection)) {
        const item = await storeItemRow(ctx, project._id, input.id, input.inlineItemOnly);
        return {
          generationId: generation._id,
          revision: generation.initialRevision,
          value: item?.value
            ? await decorate(
                await actorSummary(ctx, project._id, JSON.stringify(item.value)),
                item.planningTimes,
              )
            : null,
          ...(item?.deferred ? { deferred: true as const } : {}),
          editable: project.owner === user.subject,
          intentPin: null,
        };
      }
      const row = await record(ctx, recordPartition(generation), input.collection, input.id);
      if (
        input.inlineItemOnly &&
        input.collection === 'planningItems' &&
        row &&
        JSON.parse(row.value).payloadKey
      )
        return {
          generationId: generation._id,
          revision: generation.initialRevision,
          value: null,
          deferred: true as const,
          editable: project.owner === user.subject,
          intentPin: null,
        };
      const main = ['lanes', 'views', 'runs'].includes(input.collection)
        ? await hostedMain(ctx, generation)
        : null;
      let editable = project.owner === user.subject,
        intentPin: string | null = null;
      if (input.collection === 'intents') {
        const event = await findWorkEvent(ctx, project._id, input.id, { authority: true });
        // Write access, direct or through a linked team: the same check the Intent edit mutation makes.
        const membership = await hasWriteRole(ctx, project, user.subject);
        const intent = row ? JSON.parse(row.value) : null;
        const authority = await record(
          ctx,
          recordPartition(generation),
          'intentAuthorities',
          `${input.id}:${user.subject}`,
        );
        editable ||=
          Boolean(membership) &&
          (Boolean(authority) ||
            intent?.creatorAccountId === user.subject ||
            (Array.isArray(intent?.assigneeAccountIds) && intent.assigneeAccountIds.includes(user.subject)));
        if (event && JSON.parse(event.command).action === 'intent') {
          editable ||= event.actor === user.subject && Boolean(membership);
          const backup = event.baseBackupId ? await ctx.db.get(event.baseBackupId) : null;
          if (backup && editable)
            intentPin = JSON.stringify({
              intentId: input.id,
              baseBackupId: backup._id,
              baseArchiveSha256: backup.digest,
              baseState: JSON.parse(event.command).base,
            });
        }
      }
      return {
        generationId: generation._id,
        revision: generation.initialRevision,
        value: row
          ? await decorate(
              await cockpitSummary(
                ctx,
                project,
                generation,
                row.collection,
                await hostedRecordValue(ctx, recordPartition(generation), row),
                main,
              ),
            )
          : null,
        editable,
        intentPin,
      };
    } catch (error) {
      return report(error);
    } finally {
      await logIoAttribution(ctx, 'work-index/detail');
    }
  },
});
/** The live Work journal revision, for the few screens that show or hand it off (local handoff, source
 * verification). It reads the per-project head, so it re-runs on every journal write: subscribe only
 * while such a screen is open. */
export const revision = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, projectId, user.subject),
        selected = await selectedGeneration(ctx, project);
      return selected ? (await generationHead(ctx, selected)).revision : null;
    } catch (error) {
      return report(error);
    }
  },
});

export async function journalWorkRecordsRead(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    generationId?: Id<'projectWorkGenerations'>;
    collection: string;
    planningFilter?: Infer<typeof planningFilter>;
    counts?: boolean;
    initiativeProgress?: true;
    planningHistory?: true | number;
    memberCommentsOnly?: true;
    newestFirst?: boolean;
    parentId?: string;
    paginationOpts: PaginationOptions;
  },
) {
  try {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
    const project = await accessibleProject(ctx, input.projectId, user.subject),
      generation = await selectedGeneration(ctx, project);
    invariant(
      !input.paginationOpts.cursor ||
        !input.generationId ||
        generation?.recordsGenerationId !== input.generationId ||
        generation._id === input.generationId,
      'WORK_STALE',
      'Work generation changed. Restart this list.',
    );
    if (!generation || (input.generationId && input.generationId !== generation._id))
      return { generationId: null, revision: null, page: [], isDone: true, continueCursor: '' };
    const planningHistory =
      input.planningHistory !== undefined &&
      input.collection === 'planningItems' &&
      (await readProjectRole(ctx, project, user.subject));
    const initiativeId = input.planningFilter?.initiativeId;
    const history =
      planningHistory &&
      input.counts &&
      input.initiativeProgress &&
      initiativeId &&
      !input.paginationOpts.cursor
        ? await initiativeCloseHistory(
            ctx,
            project,
            recordPartition(generation),
            initiativeId,
            Date.now(),
            typeof input.planningHistory === 'number' ? input.planningHistory : undefined,
          )
        : undefined;
    if (
      input.initiativeProgress &&
      input.counts &&
      input.collection === 'planningItems' &&
      input.planningFilter &&
      (await readProjectRole(ctx, project, user.subject))
    ) {
      const page = await countedInitiative(
        ctx,
        generation,
        input.planningFilter,
        input.paginationOpts.cursor,
      );
      if (page)
        return {
          ...page,
          ...(history ? { history } : {}),
          generationId: generation._id,
          revision: generation.initialRevision,
        };
    }
    const numItems = Math.min(input.paginationOpts.numItems, 100);
    const store = readsStore(project, input.collection, input.parentId);
    const partition = recordPartition(generation);
    const payloads = new Map<string, Promise<Map<string, string>>>();
    const readItem = async (id: string) => {
      if (store) return storeItem(ctx, project._id, id);
      const item = await record(ctx, partition, 'planningItems', id);
      return item ? JSON.parse(await hostedRecordValue(ctx, partition, item, payloads)) : null;
    };
    const continuation = linkedLandingCursor(input.paginationOpts.cursor, input);
    if (continuation)
      return {
        generationId: generation._id,
        revision: generation.initialRevision,
        ...(await withLandingNotes(
          ctx,
          project,
          input,
          { page: [], isDone: continuation.recordsDone, continueCursor: continuation.recordsCursor },
          readItem,
          store,
          continuation,
        )),
      };
    const end = linkedLandingCursor(input.paginationOpts.endCursor, input);
    const paginationOpts = {
      ...input.paginationOpts,
      numItems,
      ...(end ? { endCursor: end.recordsCursor } : {}),
    };
    const decorateRows = async (
      rows: { id: string; position: number; value: string; planningTimes?: PlanningTimesRead }[],
    ) => {
      const charge = planningHistoryBudget();
      const fallback =
        store && planningHistory && !input.counts ? planningTimesFallbackReporter() : undefined;
      const result = [];
      for (const { planningTimes, ...row } of rows) {
        if (planningHistory && !input.counts)
          row.value = await withPlanningTimes(
            ctx,
            project,
            partition,
            row.value,
            charge,
            planningTimes,
            fallback,
          );
        result.push(row);
      }
      return result;
    };
    if ((input.collection === 'planningItems' && input.planningFilter) || store) {
      const actors = new Map<string, Promise<boolean>>();
      const page =
        input.planningFilter && input.collection === 'planningItems'
          ? await planningPage(ctx, project, generation, {
              ...input,
              planningFilter: input.planningFilter,
              // Visitors count only the Items the public rule shows: the member-only counter never answers them.
              ...(input.counts && (await readProjectRole(ctx, project, user.subject))
                ? { members: true }
                : {}),
            })
          : await storePage(ctx, project._id, {
              ...input,
              paginationOpts,
            });
      const rows = await Promise.all(
        page.page.map(async row => ({
          id: row.id,
          position: row.position,
          value: await actorSummary(ctx, project._id, JSON.stringify(row.value), actors),
          ...(row.planningTimes ? { planningTimes: row.planningTimes } : {}),
        })),
      );
      return {
        ...page,
        generationId: generation._id,
        revision: generation.initialRevision,
        ...(history ? { history } : {}),
        ...(await withLandingNotes(
          ctx,
          project,
          input,
          { ...page, page: await decorateRows(rows) },
          readItem,
          true,
          null,
        )),
      };
    }
    const rows =
      input.parentId === undefined
        ? ctx.db
            .query(splitRecordTable(input.collection))
            .withIndex('by_generation_and_collection_and_position', q =>
              q.eq('generationId', recordPartition(generation)).eq('collection', input.collection),
            )
        : ctx.db
            .query(splitRecordTable(input.collection))
            .withIndex('by_generation_and_collection_and_parent_and_position', q =>
              q
                .eq('generationId', recordPartition(generation))
                .eq('collection', input.collection)
                .eq('parent', input.parentId!),
            );
    const main = await hostedMain(ctx, generation);
    const actors = new Map<string, Promise<boolean>>();
    const page = await rows.order(input.newestFirst ? 'desc' : 'asc').paginate(paginationOpts);
    const values = await Promise.all(
      page.page.map(async row => ({
        id: row.key,
        position: row.position,
        value: await cockpitSummary(
          ctx,
          project,
          generation,
          row.collection,
          await hostedRecordValue(ctx, recordPartition(generation), row, payloads),
          main,
          actors,
        ),
      })),
    );
    return {
      ...page,
      generationId: generation._id,
      revision: generation.initialRevision,
      ...(await withLandingNotes(
        ctx,
        project,
        input,
        { ...page, page: await decorateRows(values) },
        readItem,
        false,
        null,
      )),
    };
  } catch (error) {
    if (error instanceof JournalNeeded)
      return {
        ...JSON.parse(await journalReadReply(ctx, error, input.projectId)),
        generationId: input.generationId ?? null,
        revision: null,
        page: [],
        isDone: false,
        continueCursor: input.paginationOpts.cursor ?? '',
      };
    return report(error);
  }
}
