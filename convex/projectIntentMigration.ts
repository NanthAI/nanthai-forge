// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
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
