// SPDX-License-Identifier: Apache-2.0
import { likelyPlanningDuplicates } from './projectHostedPlanningSearch';
import { needsFix } from '../src/culprit-bisect';
import { githubMirrorStatus } from './projectGithubMirrorStatus';
import { hostedRecordValue } from './hostedRecordValue';
import { hostedPaths } from '../src/hosted-paths';
import { generationHead } from './projectWorkHead';
import { cockpitSummary, hostedMain } from './projectWorkIndexSummary';
import { effectivePolicy } from '../src/autonomy-policy';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { invariant } from '../src/errors';
import { report } from './errors';
import { actorSummary } from './projectActorNames';
import { readsStore, storeItem, storePage } from './projectWorkStoreReads';
const selection = {
  projectId: v.id('hostedProjects'),
  generationId: v.optional(v.id('projectWorkGenerations')),
};
const identity = {
  generationId: v.union(v.id('projectWorkGenerations'), v.null()),
  revision: v.union(v.number(), v.null()),
};
export const workspace = query({
  args: { projectId: v.id('hostedProjects'), planningDuplicateText: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { projectId, planningDuplicateText }) => {
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
            .query('projectWorkRecords')
            .withIndex('by_generation_and_collection_and_position', q =>
              q.eq('generationId', recordPartition(generation)).eq('collection', collection),
            )
            .take(1);
          if (first) counts[collection] = 1;
        }
      const backup = await ctx.db.get(generation.backupId);
      invariant(backup?.projectId === projectId, 'PROJECT_UNAVAILABLE', 'Select this project’s source.');
      const owner = project.owner === user.subject;
      const contributor =
        owner ||
        Boolean(
          await ctx.db
            .query('projectContributors')
            .withIndex('by_project_and_contributor', q =>
              q.eq('projectId', projectId).eq('contributor', user.subject),
            )
            .unique(),
        );
      return JSON.stringify({
        ...hostedPaths({ ...metadata, counts }),
        ...(planningDuplicateText === undefined
          ? {}
          : { likelyDuplicates: await likelyPlanningDuplicates(ctx, project, planningDuplicateText) }),
        autonomyPolicy: effectivePolicy(project),
        ...(project.needsFix ? { needsFix: needsFix(project) } : {}),
        githubMirror: await githubMirrorStatus(ctx, project),
        generationId: generation._id,
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
    newestFirst: v.optional(v.boolean()),
    parentId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    ...identity,
    ...paginationResultValidator(v.object({ id: v.string(), position: v.number(), value: v.string() }))
      .fields,
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, input.projectId, user.subject),
        generation = await selectedGeneration(ctx, project);
      if (!generation || (input.generationId && input.generationId !== generation._id))
        return { generationId: null, revision: null, page: [], isDone: true, continueCursor: '' };
      const numItems = Math.min(input.paginationOpts.numItems, 100);
      if (readsStore(project, input.collection, input.parentId)) {
        const actors = new Map<string, Promise<boolean>>();
        const page = await storePage(ctx, project._id, {
          ...input,
          paginationOpts: { ...input.paginationOpts, numItems },
        });
        return {
          ...page,
          generationId: generation._id,
          revision: generation.initialRevision,
          page: await Promise.all(
            page.page.map(async row => ({
              id: row.id,
              position: row.position,
              value: await actorSummary(ctx, project._id, JSON.stringify(row.value), actors),
            })),
          ),
        };
      }
      const rows =
        input.parentId === undefined
          ? ctx.db
              .query('projectWorkRecords')
              .withIndex('by_generation_and_collection_and_position', q =>
                q.eq('generationId', recordPartition(generation)).eq('collection', input.collection),
              )
          : ctx.db
              .query('projectWorkRecords')
              .withIndex('by_generation_and_collection_and_parent_and_position', q =>
                q
                  .eq('generationId', recordPartition(generation))
                  .eq('collection', input.collection)
                  .eq('parent', input.parentId!),
              );
      const main = await hostedMain(ctx, generation);
      const actors = new Map<string, Promise<boolean>>();
      const payloads = new Map<string, Promise<Map<string, string>>>();
      const page = await rows
        .order(input.newestFirst ? 'desc' : 'asc')
        .paginate({ ...input.paginationOpts, numItems });
      return {
        ...page,
        generationId: generation._id,
        revision: generation.initialRevision,
        page: await Promise.all(
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
        ),
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const detail = query({
  args: { ...selection, collection: v.string(), id: v.string() },
  returns: v.object({
    ...identity,
    value: v.union(v.string(), v.null()),
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
      if (input.collection === 'planningItems' && readsStore(project, input.collection)) {
        const item = await storeItem(ctx, project._id, input.id);
        return {
          generationId: generation._id,
          revision: generation.initialRevision,
          value: item ? await actorSummary(ctx, project._id, JSON.stringify(item)) : null,
          editable: project.owner === user.subject,
          intentPin: null,
        };
      }
      const row = await record(ctx, recordPartition(generation), input.collection, input.id),
        main = await hostedMain(ctx, generation);
      let editable = project.owner === user.subject,
        intentPin: string | null = null;
      if (input.collection === 'intents') {
        const event = await ctx.db
          .query('projectWorkEvents')
          .withIndex('by_project_and_operation', q =>
            q.eq('projectId', project._id).eq('operationId', input.id),
          )
          .unique();
        const membership = await ctx.db
          .query('projectContributors')
          .withIndex('by_project_and_contributor', q =>
            q.eq('projectId', input.projectId).eq('contributor', user.subject),
          )
          .unique();
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
          ? await cockpitSummary(
              ctx,
              project,
              generation,
              row.collection,
              await hostedRecordValue(ctx, recordPartition(generation), row),
              main,
            )
          : null,
        editable,
        intentPin,
      };
    } catch (error) {
      return report(error);
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
