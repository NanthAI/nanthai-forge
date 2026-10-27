// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { exchangeObjectReader } from './projectExchangeReader';
import { recordExchange } from './projectWorkRecordExchange';

/** Explicit, project-scoped repair; never scans backups or runs automatically. */
export const backfill = internalAction({
  args: { projectId: v.id('hostedProjects'), dryRun: v.boolean() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const value = JSON.parse(
      await ctx.runQuery(
        makeFunctionReference<'query', { projectId: typeof input.projectId }, string>(
          'projectHostedSeedRecordStore:inspect',
        ),
        { projectId: input.projectId },
      ),
    ) as { seed: Doc<'projectHostedSeeds'>; backup: Doc<'projectBackups'> } | null;
    const changes: { projectId: string; backupId: string; operationId: string }[] = [];
    if (value && value.backup.validatedWorkRecords !== 1) {
      // The paged seed validated the bodies. Confirm this is its schema-2
      // catalog, rather than marking Git or legacy schema-1 seeds as records.
      const catalog = await recordExchange(value.backup, value.seed.owner, exchangeObjectReader(ctx));
      if (catalog) {
        changes.push({
          projectId: input.projectId,
          backupId: value.backup._id,
          operationId: value.seed.operationId,
        });
        if (!input.dryRun)
          await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSeedRecordStore:mark'), {
            projectId: input.projectId,
            backupId: value.backup._id,
            request: value.seed.request,
          });
      }
    }
    return JSON.stringify({ dryRun: input.dryRun, changes });
  },
});
