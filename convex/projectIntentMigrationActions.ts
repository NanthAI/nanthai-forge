// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { caller, load } from './projectWorkActions';
import { workProjection } from './projectSourceProjection';
import {
  convertHostedIntents,
  migrateHostedIntents,
  validateUnifiedHostedWork,
} from '../src/work-hosted-intents';
import { invariant } from '../src/errors';
import { report } from './errors';

export const migrate = action({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.id('projectWorkGenerations'),
  handler: async (ctx, input): Promise<Id<'projectWorkGenerations'>> => {
    try {
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Use an original Intent migration operation UUID.',
      );
      const owner = await caller(ctx);
      while (true) {
        const project: Doc<'hostedProjects'> = await ctx.runQuery(internal.projectWork.owner, {
          projectId: input.projectId,
          owner,
        });
        if (project.work?.intentMigration) return project.work.intentMigration.generationId;
        const snapshot = await load(ctx, input.projectId, owner, undefined, { requireCurrent: true });
        snapshot.data = migrateHostedIntents(snapshot.data, {
          operationId: input.operationId,
          revision: snapshot.data.revision,
        });
        validateUnifiedHostedWork(snapshot.data);
        const projection = await workProjection(ctx, snapshot, owner);
        const generation: Doc<'projectWorkGenerations'> | null = await ctx.runMutation(
          internal.projectIntentMigration.begin,
          {
            ...input,
            owner,
            backupId: snapshot.backup._id,
            revision: snapshot.data.revision,
            metadata: JSON.stringify(projection.metadata),
          },
        );
        if (!generation) continue;
        let batch = 0,
          current = true;
        for await (const entries of projection.batches()) {
          if (batch >= generation.nextBatch)
            current = await ctx.runMutation(internal.projectWorkIndexStore.batch, {
              projectId: input.projectId,
              owner,
              generationId: generation._id,
              batch,
              entries,
            });
          batch++;
          if (!current) break;
        }
        if (
          current &&
          (await ctx.runMutation(internal.projectIntentMigration.publish, {
            ...input,
            owner,
            generationId: generation._id,
            batches: batch,
            metadata: JSON.stringify(projection.metadata),
          }))
        )
          return generation._id;
        // A concurrent journal append wins. Reconstruct its full lineage at the new revision.
      }
    } catch (error) {
      return report(error);
    }
  },
});

/** Run the same conversion and validation without staging or selecting a generation. */
export const preview = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { ...input, owner });
      const snapshot = await load(ctx, input.projectId, owner, undefined, {
        requireCurrent: true,
        cacheMetadata: false,
      });
      const converted = convertHostedIntents(snapshot.data);
      const unified = validateUnifiedHostedWork(converted);
      const alreadyUnified = [16, 18].includes(snapshot.data.schema);
      const current = {
        intents: unified.intents.length,
        initiatives: unified.initiatives.length,
        aliases: unified.intentAliases.length,
      };
      return JSON.stringify({
        dryRun: true,
        revision: snapshot.data.revision,
        alreadyUnified,
        counts: alreadyUnified
          ? { before: current, after: current, foldedPairs: 0 }
          : unified.intentMergeReceipt.counts,
      });
    } catch (error) {
      return report(error);
    }
  },
});
