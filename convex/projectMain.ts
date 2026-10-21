// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { invariant } from '../src/errors';
import { hostedMainSchema } from '../src/hosted-main';
import { requireSourceContract, sourceAuthority } from '../src/hosted-source-authority';
import { report } from './errors';
/** One transaction observes both the selected source generation and Channel receipt. */
export const current = query({
  args: {
    projectId: v.id('hostedProjects'),
    maxSchema: v.optional(v.union(v.literal(1), v.literal(2))),
    expected: v.optional(v.object({ head: v.string(), receiptId: v.string() })),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, expected, maxSchema }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted main.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const authority = sourceAuthority(project);
      requireSourceContract(authority, maxSchema);
      // H01 defines the contract; authoritative server snapshot publication follows separately.
      invariant(authority.mode !== 'server', 'SOURCE_UNAVAILABLE', 'Server main snapshot is not ready.');
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'PROJECT_WORK_MISSING', 'Hosted source index is not ready.');
      const backup = await ctx.db.get(generation.backupId);
      invariant(
        backup?.projectId === projectId && backup.preview.format === 'native',
        'SOURCE_UNAVAILABLE',
        'Select native hosted source.',
      );
      const partition = recordPartition(generation),
        hosted = await record(ctx, partition, 'hostedChannels', 'main');
      let move;
      if (hosted) move = JSON.parse(hosted.value);
      else {
        // The index preserves accepted receipt order, including repeated heads.
        let cursor: string | null = null;
        do {
          const page = await ctx.db
            .query('projectWorkRecords')
            .withIndex('by_generation_and_collection_and_parent_and_position', q =>
              q.eq('generationId', partition).eq('collection', 'channelMoves').eq('parent', 'main'),
            )
            .order('desc')
            .paginate({ cursor, numItems: 100 });
          move = page.page.map(row => JSON.parse(row.value)).find(row => row.status === 'accepted');
          cursor = page.isDone ? null : page.continueCursor;
        } while (!move && cursor);
      }
      invariant(move, 'SOURCE_UNAVAILABLE', 'Hosted main has no accepted Channel receipt.');
      const prior =
        hosted && move.previousId
          ? await record(ctx, partition, 'hostedChannelMoves', move.previousId)
          : null;
      const result = hostedMainSchema.parse({
        schema: 1,
        projectId,
        generationId: generation._id,
        backupId: generation.backupId,
        channel: 'main',
        head: move.head,
        receipt: {
          id: move.id,
          kind: hosted ? 'hosted' : 'native',
          previousHead: prior ? JSON.parse(prior.value).head : (move.previous ?? null),
          previousReceiptId: move.previousId ?? null,
        },
      });
      invariant(
        !expected || (expected.head === result.head && expected.receiptId === result.receipt.id),
        'CHANNEL_CHANGED',
        'Hosted main changed from the expected head and receipt.',
      );
      return JSON.stringify(result);
    } catch (error) {
      return report(error);
    }
  },
});
/** Wants metadata uses existing project-scoped object bindings and current reader authority. */
export const objects = query({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(v.object({ sha256: v.string(), size: v.number() })),
  handler: async (ctx, { projectId, digests }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted source.');
      await accessibleProject(ctx, projectId, user.subject);
      return await Promise.all(
        digests.map(async sha256 => {
          const row = await ctx.db
            .query('projectObjects')
            .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', sha256))
            .unique();
          invariant(
            row && !row.removed && isStored(row),
            'SOURCE_UNAVAILABLE',
            'Requested project source object is unavailable.',
          );
          return { sha256, size: row.size };
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
