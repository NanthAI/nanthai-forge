// SPDX-License-Identifier: Apache-2.0
import { requireSourceAuthority } from '../src/hosted-source-authority';
import { indexActivity } from '../src/work-hosted-index';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { commandProjection } from './projectWorkProjection';
import { workProject, setWorkHead } from './projectWorkHead';
import { acceptanceEvidence } from './autonomyFields';
import { acceptanceActor } from './projectAutonomy';
import {
  effectivePolicy,
  reviewReason,
  hostedAcceptanceCommandSchema as hostedChannelCommandSchema,
} from '../src/autonomy-policy';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, internalQuery, internalMutation } from './cliServer';
import { projectDocument, hostedWorkEventDocument } from './schema';
import { ownedProject, accessibleProject, activeOwnedProject, activeProject } from './projectAuthority';
import { intentAuthority } from './projectContributors';
import { metadataCommandSchema } from '../src/work-intent-types';
import { invariant } from '../src/errors';
import { indexEntry } from './projectWorkIndexFields';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { internal } from './_generated/api';
import { report } from './errors';
import { emitChange, workChange } from './coordinationWrite';

export const state = query({
  args: { projectId: v.id('hostedProjects') },
  returns: projectDocument,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      return await workProject(ctx, await accessibleProject(ctx, projectId, user.subject));
    } catch (error) {
      return report(error);
    }
  },
});
// Observe only the selected backup row, including an in-place transport conversion.
export const sourceTransport = query({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups') },
  returns: v.object({
    backupId: v.id('projectBackups'),
    digest: v.string(),
    head: v.string(),
    kind: v.union(v.literal('native'), v.literal('git')),
    transport: v.union(v.literal('archive'), v.literal('objects')),
    manifestDigest: v.string(),
  }),
  handler: async (ctx, { projectId, backupId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      await accessibleProject(ctx, projectId, user.subject);
      const backup = await ctx.db.get(backupId);
      invariant(
        backup?.projectId === projectId && backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select this project’s stored source and Work.',
      );
      return {
        backupId,
        digest: backup.digest,
        head: backup.preview.head,
        kind: backup.preview.format === 'native' ? ('native' as const) : ('git' as const),
        transport: backup.transport ?? ('archive' as const),
        manifestDigest: backup.objectManifest?.digest ?? backup.preview.manifestDigest,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const get = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: projectDocument,
  handler: async (ctx, { projectId, owner }) => {
    try {
      return await workProject(ctx, await accessibleProject(ctx, projectId, owner));
    } catch (error) {
      return report(error);
    }
  },
});
export const owner = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: projectDocument,
  handler: async (ctx, { projectId, owner }) => {
    try {
      return await ownedProject(ctx, projectId, owner);
    } catch (error) {
      return report(error);
    }
  },
});
export const find = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string(), operationId: v.string() },
  returns: v.union(hostedWorkEventDocument, v.null()),
  handler: async (ctx, { projectId, owner, operationId }) => {
    try {
      await accessibleProject(ctx, projectId, owner);
      const event = await ctx.db
        .query('projectWorkEvents')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique();
      invariant(
        !event || event.actor === owner,
        'WORK_OPERATION_CHANGED',
        'This operation belongs to another actor.',
      );
      return event;
    } catch (error) {
      return report(error);
    }
  },
});
export const events = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    initialRevision: v.number(),
    revision: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(hostedWorkEventDocument),
  handler: async (ctx, { projectId, owner, initialRevision, revision, paginationOpts }) => {
    try {
      await accessibleProject(ctx, projectId, owner);
      return await ctx.db
        .query('projectWorkEvents')
        .withIndex('by_project_and_revision', q =>
          q.eq('projectId', projectId).gt('revision', initialRevision).lte('revision', revision),
        )
        .order('asc')
        .paginate(paginationOpts);
    } catch (error) {
      return report(error);
    }
  },
});
export const initialize = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    backupId: v.id('projectBackups'),
    operationId: v.string(),
    revision: v.number(),
  },
  returns: projectDocument,
  handler: async (ctx, { projectId, owner, backupId, operationId, revision }) => {
    try {
      const project = await activeOwnedProject(ctx, projectId, owner),
        backup = await ctx.db.get(backupId);
      invariant(
        backup?.projectId === projectId && backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select this project’s stored source and Work.',
      );
      if (project.work) {
        invariant(
          (project.work.originBackupId ?? project.work.backupId) === backupId &&
            project.work.operationId === operationId,
          'PROJECT_WORK_EXISTS',
          'This project already has hosted Work. Its source and journal remain selected.',
        );
        return project;
      }
      await ctx.db.patch(projectId, {
        work: { backupId, operationId, initialRevision: revision, revision },
        revision: project.revision + 1,
      });
      return (await ctx.db.get(projectId))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const append = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    previousRevision: v.number(),
    command: v.string(),
    authorityEpoch: v.optional(v.number()),
    projection: v.optional(
      v.object({
        generationId: v.id('projectWorkGenerations'),
        acceptance: v.optional(acceptanceEvidence),
        metadata: v.string(),
        entries: v.array(indexEntry),
        at: v.string(),
      }),
    ),
  },
  returns: hostedWorkEventDocument,
  handler: appendWork,
});

export async function appendWork(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    operationId: string;
    request: string;
    previousRevision: number;
    command: string;
    projection?: ReturnType<typeof commandProjection>;
    authorityEpoch?: number;
  },
) {
  try {
    const project = await workProject(ctx, await activeProject(ctx, input.projectId, input.owner));
    const channelCommand = hostedChannelCommandSchema.safeParse(JSON.parse(input.command));
    if (channelCommand.success)
      requireSourceAuthority(project, { mode: 'native-owner', epoch: input.authorityEpoch ?? 0 });
    const parsed = metadataCommandSchema.safeParse(JSON.parse(input.command));
    if (
      parsed.success &&
      (parsed.data.action === 'put-planning-item' || parsed.data.action === 'comment-planning-item')
    ) {
      invariant(
        project.owner === input.owner,
        'PROJECT_UNAVAILABLE',
        'Project planning is available to its current owner.',
      );
      invariant(
        parsed.data.operationId === input.operationId,
        'BAD_ARGUMENT',
        'Use the planning command’s original operation UUID.',
      );
    } else if (project.owner !== input.owner) {
      const command = metadataCommandSchema.parse(JSON.parse(input.command));
      invariant(
        command.action === 'intent' || command.action === 'note' || command.action === 'intent-status',
        'PROJECT_UNAVAILABLE',
        'Select your existing contributor Work command.',
      );
      if (command.action !== 'intent')
        await intentAuthority(ctx, input.projectId, input.owner, command.intentId);
    }
    const original = await ctx.db
      .query('projectWorkEvents')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (original) {
      invariant(
        original.actor === input.owner &&
          original.request === input.request &&
          original.previousRevision === input.previousRevision,
        'WORK_OPERATION_CHANGED',
        'Reconcile this operation’s original command and revision.',
      );
      return original;
    }
    if (channelCommand.success) {
      const actor = await acceptanceActor(ctx, channelCommand.data.agent),
        policy = effectivePolicy(project),
        evidence = input.projection?.acceptance;
      invariant(
        actor.id === input.owner && project.owner === actor.id,
        'PROJECT_UNAVAILABLE',
        'Channel acceptance requires the current signed-in project owner.',
      );
      invariant(
        evidence && JSON.stringify(evidence.policy) === JSON.stringify(policy),
        'POLICY_CHANGED',
        'Project policy changed during acceptance. Refresh before accepting.',
      );
      invariant(
        evidence.containsPrevious,
        'CHANNEL_DIVERGED',
        'Acceptance would lose the current Channel head.',
      );
      const reason = reviewReason(policy, actor, evidence.paths);
      invariant(!reason, 'REVIEW_REQUIRED', reason ?? 'Waiting for review by a person');
      if (actor.kind === 'agent') {
        const generation = await selectedGeneration(ctx, project);
        invariant(
          generation && generation._id === input.projection?.generationId,
          'WORK_STALE',
          'Hosted source changed during acceptance.',
        );
        const storedRun = evidence.automatic?.runId
          ? await record(ctx, recordPartition(generation), 'runs', evidence.automatic.runId)
          : null;
        const run = storedRun ? JSON.parse(storedRun.value) : null;
        invariant(
          run?.status === 'passed' &&
            run.checkSelection?.scope !== 'partial' &&
            run.head === channelCommand.data.head &&
            run.viewId === channelCommand.data.viewId,
          'CHECK_REQUIRED',
          'Automatic acceptance requires a passing check for this exact View at the Channel boundary.',
        );
      }
      invariant(
        actor.kind === 'person' || (evidence.automatic?.actor === actor.id && evidence.automatic.runId),
        'CHECK_REQUIRED',
        'Automatic acceptance requires exact-View passing evidence.',
      );
    }
    invariant(
      project.work?.revision === input.previousRevision,
      'WORK_STALE',
      'Hosted Work changed. Your request and existing work remain available.',
    );
    if (input.projection) {
      const generation = await selectedGeneration(ctx, project);
      invariant(
        generation?._id === input.projection.generationId,
        'WORK_STALE',
        'Hosted source or Work changed.',
      );
      for (const entry of input.projection.entries) {
        const old = await record(ctx, recordPartition(generation), entry.collection, entry.key);
        if (old) {
          if (!entry.collection.endsWith(':payload')) {
            const payloadKey = JSON.parse(old.value).payloadKey;
            if (payloadKey && JSON.parse(entry.value).payloadKey !== payloadKey)
              await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retirePayload, {
                projectId: project._id,
                generationId: recordPartition(generation),
                collection: entry.collection,
                key: entry.key,
                payloadKey,
              });
          }
          await ctx.db.patch(old._id, { ...entry, ...indexActivity(entry) });
        } else
          await ctx.db.insert('projectWorkRecords', {
            ...entry,
            ...indexActivity(entry),
            projectId: project._id,
            generationId: recordPartition(generation),
          });
      }
      const metadata = JSON.parse(input.projection.metadata);
      if (parsed.success && (parsed.data.action === 'intent' || parsed.data.action === 'intent-status')) {
        const active = await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_status_and_position', q =>
            q
              .eq('generationId', recordPartition(generation))
              .eq('collection', 'intents')
              .eq('status', 'active'),
          )
          .order('desc')
          .take(1);
        const last =
          active[0] ??
          (
            await ctx.db
              .query('projectWorkRecords')
              .withIndex('by_generation_and_collection_and_position', q =>
                q.eq('generationId', recordPartition(generation)).eq('collection', 'intents'),
              )
              .order('desc')
              .take(1)
          )[0];
        metadata.defaultIntentId = last?.key;
      }
      await setWorkHead(
        ctx,
        project._id,
        project.work!.backupId,
        input.previousRevision + 1,
        JSON.stringify(metadata),
      );
    }
    const id = await ctx.db.insert('projectWorkEvents', {
      projectId: input.projectId,
      operationId: input.operationId,
      request: input.request,
      previousRevision: input.previousRevision,
      revision: input.previousRevision + 1,
      command: input.command,
      ...(input.projection?.acceptance?.automatic
        ? { automatic: input.projection.acceptance.automatic }
        : {}),
      actor: input.owner,
      at: input.projection?.at ?? new Date().toISOString(),
      ...(JSON.parse(input.command).action === 'intent' ? { baseBackupId: project.work!.backupId } : {}),
    });
    await emitChange(ctx, {
      projectId: input.projectId,
      actor: input.owner,
      operationId: `work:${input.operationId}`,
      source: 'work',
      ...workChange(input.command),
    });
    if (!input.projection) {
      await setWorkHead(ctx, project._id, project.work!.backupId, input.previousRevision + 1);
      await ctx.db.patch(project._id, { work: { ...project.work!, generationId: undefined } });
    }
    return (await ctx.db.get(id))!;
  } catch (error) {
    return report(error);
  }
}
