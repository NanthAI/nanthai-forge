// SPDX-License-Identifier: Apache-2.0
import { activityFields } from '../src/work-hosted-index';
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';
import { generationHead, setWorkHead } from './projectWorkHead';
import { githubStatusSchema } from '../src/github-status-types';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Explicit GitHub mirror display. Never publishes Lane, Candidate or Channel state. */
export const publish = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), metadata: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to publish GitHub mirror status.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Use an original metadata operation UUID.',
      );
      const parsed = githubStatusSchema.safeParse(JSON.parse(input.metadata));
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send GitHub mirror status only.');
      const payload = parsed.data;
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare hosted Work before syncing metadata.');
      const generationId = recordPartition(generation);
      const receipt = await record(ctx, generationId, 'ownerSyncOperations', input.operationId);
      if (receipt) {
        invariant(
          receipt.value === input.metadata,
          'WORK_OPERATION_CHANGED',
          'Replay the original metadata operation and payload.',
        );
        return null;
      }
      // A source push already contains the local Work through its initial revision.
      if (payload.revision < generation.initialRevision) return null;
      const head = await generationHead(ctx, generation);
      const metadata = JSON.parse(head.metadata);
      let added = false;
      for (const entry of payload.entries) {
        invariant(
          entry.value.id === entry.key,
          'BAD_ARGUMENT',
          'Metadata identity must match its record key.',
        );
        const markerKey = JSON.stringify([payload.ownerId, entry.collection, entry.key]);
        const marker = await record(ctx, generationId, 'ownerSync', markerKey);
        const previous = marker ? JSON.parse(marker.value) : null;
        if (previous?.revision > payload.revision) continue;
        if (previous?.revision === payload.revision) {
          // Same local revision can report different phases, but the underlying record must agree.
          invariant(
            previous.value === JSON.stringify(entry.value),
            'WORK_OPERATION_CHANGED',
            'Replay the original local metadata revision.',
          );
          continue;
        }
        const old = await record(ctx, generationId, entry.collection, entry.key);
        const oldValue = old ? JSON.parse(old.value) : {};
        // Preserve existing mirror fields outside this observation.
        const value = { ...oldValue, ...entry.value };
        const fields = {
          activityAt: activityFields(entry.collection, value).activityAt,
          projectId: input.projectId,
          generationId,
          collection: entry.collection,
          key: entry.key,
          parent: entry.parent,
          position: old?.position ?? payload.revision,
          value: JSON.stringify(value),
          ...(typeof value.status === 'string' ? { status: value.status } : {}),
        };
        if (old) await ctx.db.patch(old._id, fields);
        else {
          await ctx.db.insert('projectWorkRecords', fields);
          metadata.counts[entry.collection] = (metadata.counts[entry.collection] ?? 0) + 1;
          added = true;
        }
        const observed = {
          projectId: input.projectId,
          generationId,
          collection: 'ownerSync',
          key: markerKey,
          parent: payload.ownerId,
          position: payload.revision,
          value: JSON.stringify({
            revision: payload.revision,
            operationId: input.operationId,
            value: JSON.stringify(entry.value),
          }),
        };
        if (marker) await ctx.db.replace(marker._id, observed);
        else await ctx.db.insert('projectWorkRecords', observed);
      }
      await ctx.db.insert('projectWorkRecords', {
        projectId: input.projectId,
        generationId,
        collection: 'ownerSyncOperations',
        key: input.operationId,
        parent: payload.ownerId,
        position: payload.revision,
        value: input.metadata,
      });
      if (added)
        await setWorkHead(ctx, project._id, generation.backupId, head.revision, JSON.stringify(metadata));
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
