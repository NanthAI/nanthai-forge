// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, query } from './cliServer';
import { report } from './errors';
import { activeOwnedProject } from './projectAuthority';
import { workProject, setWorkHead } from './projectWorkHead';
import { generationDocument } from './projectWorkIndexFields';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { invariant } from '../src/errors';

/** Private staged generations retain the original backup/journal and previous selection. */
export const begin = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    backupId: v.id('projectBackups'),
    revision: v.number(),
    metadata: v.string(),
  },
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
    invariant(project.work, 'PROJECT_WORK_MISSING', 'Initialize hosted Work before migrating Intents.');
    if (
      project.work.intentMigration ||
      project.work.backupId !== input.backupId ||
      project.work.revision !== input.revision
    )
      return null;
    const previous = await ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project_and_intent_migration_and_revision', q =>
        q
          .eq('projectId', input.projectId)
          .eq('intentMigrationOperationId', input.operationId)
          .eq('revision', input.revision),
      )
      .unique();
    if (previous) {
      invariant(
        previous.backupId === input.backupId,
        'WORK_OPERATION_CHANGED',
        'Resume the original Intent migration source.',
      );
      return previous;
    }
    const id = await ctx.db.insert('projectWorkGenerations', {
      projectId: input.projectId,
      backupId: input.backupId,
      revision: input.revision,
      initialRevision: project.work.initialRevision,
      metadata: input.metadata,
      workSchema: JSON.parse(input.metadata).schema,
      intentMigrationOperationId: input.operationId,
      format: HOSTED_WORK_INDEX_FORMAT,
      status: 'building',
      nextBatch: 0,
    });
    return await ctx.db.get(id);
  },
});
export const publish = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    generationId: v.id('projectWorkGenerations'),
    batches: v.number(),
    metadata: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
    invariant(project.work, 'PROJECT_WORK_MISSING', 'Initialize hosted Work before migrating Intents.');
    if (project.work.intentMigration) return project.work.intentMigration.operationId === input.operationId;
    const generation = await ctx.db.get(input.generationId);
    invariant(
      generation?.projectId === project._id && generation.intentMigrationOperationId === input.operationId,
      'PROJECT_UNAVAILABLE',
      'Select this project’s original Intent migration generation.',
    );
    if (project.work.backupId !== generation.backupId || project.work.revision !== generation.revision)
      return false;
    invariant(
      generation.nextBatch === input.batches && [16, 18, 20].includes(JSON.parse(input.metadata).schema),
      'INVALID_WORK_JOURNAL',
      'Complete all unified Intent projection batches before publication.',
    );
    const previous = project.work.generationId ? await ctx.db.get(project.work.generationId) : null;
    if (previous) {
      await ctx.db.patch(previous._id, { retainedForIntentMigration: input.operationId });
      if (previous.recordsGenerationId)
        await ctx.db.patch(previous.recordsGenerationId, { retainedForIntentMigration: input.operationId });
    }
    await ctx.db.patch(generation._id, {
      status: 'ready',
      metadata: input.metadata,
      retainedForIntentMigration: input.operationId,
    });
    await setWorkHead(ctx, project._id, generation.backupId, generation.revision, input.metadata);
    await ctx.db.patch(project._id, {
      work: {
        ...project.work,
        generationId: generation._id,
        intentMigration: {
          operationId: input.operationId,
          revision: generation.revision,
          generationId: generation._id,
        },
      },
    });
    return true;
  },
});

/** Read only the original operation's latest staged revision, or the retained publication. */
export const progress = query({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.object({
    operationId: v.string(),
    state: v.union(v.literal('pending'), v.literal('building'), v.literal('completed')),
    generationId: v.union(v.id('projectWorkGenerations'), v.null()),
    revision: v.number(),
    batches: v.number(),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
      const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, user.subject));
      invariant(project.work, 'PROJECT_WORK_MISSING', 'Initialize hosted Work before migrating Intents.');
      const published = project.work.intentMigration;
      const generation = published
        ? await ctx.db.get(published.generationId)
        : (
            await ctx.db
              .query('projectWorkGenerations')
              .withIndex('by_project_and_intent_migration_and_revision', q =>
                q.eq('projectId', input.projectId).eq('intentMigrationOperationId', input.operationId),
              )
              .order('desc')
              .take(1)
          )[0];
      return {
        operationId: published?.operationId ?? input.operationId,
        state: published ? ('completed' as const) : generation ? ('building' as const) : ('pending' as const),
        generationId: published?.generationId ?? generation?._id ?? null,
        revision: published?.revision ?? generation?.revision ?? project.work.revision,
        batches: generation?.nextBatch ?? 0,
      };
    } catch (error) {
      return report(error);
    }
  },
});
