// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { activeStep } from './projectConvexSourceStore';
import { saveObject } from './projectHostedSaveStore';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
import { sourceMutation } from './projectConvexSourceErrors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { presignGet, r2Config } from './r2';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string(), step: v.number() };
/** Object storage locations stay inside the trusted action. No worker HTTP
 * grant, callback ingress, HMAC, Modal credential or repository URL is involved. */
export const resolve = sourceMutation({
  args: {
    ...identity,
    digests: v.array(v.string()),
    ancestry: v.boolean(),
    known: v.array(v.string()),
    windows: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    invariant(
      !args.windows || (Number.isInteger(args.windows) && args.windows >= 1 && args.windows <= 4),
      'SOURCE_JOB_INVALID',
      'Prepare bounded source windows.',
    );
    const active = await activeStep(ctx, args);
    invariant(active, 'SOURCE_JOB_FENCED', 'Source step advanced.');
    invariant(args.digests.length <= 100, 'SOURCE_JOB_INVALID', 'Resolve source in bounded windows.');
    const project = await ctx.db.get(args.projectId),
      generation = project ? await selectedGeneration(ctx, project) : null;
    const pending = [...args.digests].reverse(),
      seen = new Set(args.known),
      result: {
        descriptor: Awaited<ReturnType<typeof saveObject>>;
        storageId: Id<'_storage'> | null;
        url: string | null;
      }[] = [];
    let bytes = 0;
    while (pending.length && result.length < 100 * (args.windows ?? 1)) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', args.projectId).eq('digest', id))
        .unique();
      if (!row || row.removed || !isStored(row)) {
        invariant(!args.digests.includes(id), 'SOURCE_UNAVAILABLE', 'Exact source object is absent.');
        continue;
      }
      const descriptor = await saveObject(ctx, args.projectId, { sha256: id });
      if (result.length && bytes + descriptor.object.size > 8 * 1024 * 1024 * (args.windows ?? 1)) break;
      bytes += descriptor.object.size;
      const url = row.location === 'r2' && row.r2Key ? await presignGet(r2Config(), row.r2Key) : null;
      result.push({ descriptor, storageId: url ? null : (row.storageId ?? null), url });
      if (args.ancestry && generation) {
        // Hints batch a linear ancestry chain, but never establish closure.
        // Actual verified manifest parents drive every subsequent frontier.
        const hint = await record(ctx, recordPartition(generation), 'sourceStateParents', id);
        const parents = hint ? JSON.parse(hint.value).parents : undefined;
        if (Array.isArray(parents)) pending.push(...parents.filter((p: unknown) => typeof p === 'string'));
      }
    }
    return canonicalPayload(
      args.ancestry
        ? result
        : args.digests.flatMap(id => result.filter(row => row.descriptor.object.sha256 === id)),
    );
  },
});
