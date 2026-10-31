// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { activeStep } from './projectConvexSourceStore';
import { saveObjects } from './projectHostedSaveStore';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
import { sourceMutation } from './projectConvexSourceErrors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { presignGet, r2Config } from './r2';
import { findObject, type ObjectView } from './projectObjectFind';
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
      selected: { row: ObjectView; url: string | null }[] = [];
    let bytes = 0;
    while (pending.length && selected.length < 100 * (args.windows ?? 1)) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = await findObject(ctx, args.projectId, id);
      if (!row || row.removed || !isStored(row)) {
        invariant(!args.digests.includes(id), 'SOURCE_UNAVAILABLE', 'Exact source object is absent.');
        continue;
      }
      if (selected.length && bytes + row.size > 8 * 1024 * 1024 * (args.windows ?? 1)) break;
      bytes += row.size;
      const url = row.location === 'r2' && row.r2Key ? await presignGet(r2Config(), row.r2Key) : null;
      selected.push({ row, url });
      if (args.ancestry && generation) {
        // Hints batch a linear ancestry chain, but never establish closure.
        // Actual verified manifest parents drive every subsequent frontier.
        const hint = await record(ctx, recordPartition(generation), 'sourceStateParents', id);
        const parents = hint ? JSON.parse(hint.value).parents : undefined;
        if (Array.isArray(parents)) pending.push(...parents.filter((p: unknown) => typeof p === 'string'));
      }
    }
    // One reference mark and cleanup fence for the whole window, from rows read above.
    const descriptors = await saveObjects(
      ctx,
      args.projectId,
      selected.map(({ row }) => ({ sha256: row.digest })),
      selected.map(({ row }) => row),
    );
    const result = selected.map(({ row, url }, i) => ({
      descriptor: descriptors[i]!,
      storageId: url ? null : (row.storageId ?? null),
      url,
    }));
    return canonicalPayload(
      args.ancestry
        ? result
        : args.digests.flatMap(id => result.filter(row => row.descriptor.object.sha256 === id)),
    );
  },
});
