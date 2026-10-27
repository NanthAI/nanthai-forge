// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { exchangeObjectReader } from './projectExchangeReader';
import { compareCounts } from './projectDiffstats';
import { parseNativeState } from '../src/native-state-format';
import { reviewPaths } from '../src/native-source-review';
import { invariant } from '../src/errors';
import { report } from './errors';
import type { Pin } from './projectDiffstatProjection';
/** Explicit View opens only. No scheduled work; immutable pairs are saved once. */
export const compute = action({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    viewId: v.string(),
    recomputeOwner: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project Views.');
      const { recomputeOwner, ...selection } = input;
      const request = { ...selection, actor: user.subject };
      const selected = JSON.parse(await ctx.runQuery(internal.projectViewDiffstatStore.read, request));
      if (selected.changes && (!recomputeOwner || selected.changes.provenance === 'server-computed'))
        return JSON.stringify(selected.changes);
      const pins: Pin[] = selected.pins.map((p: Pin) => ({ sha256: p.sha256, size: p.size }));
      const bytes = await exchangeObjectReader(ctx, false, 0).read(input.projectId, user.subject, pins);
      const paths = reviewPaths(parseNativeState(bytes[0]!).files, parseNativeState(bytes[1]!).files).filter(
        f => f.status !== 'unchanged',
      );
      const hashes = [
        ...new Set(paths.flatMap(f => [f.before?.blob, f.after?.blob].filter((h): h is string => !!h))),
      ];
      const blobs = new Map<string, Pin>();
      for (let offset = 0; offset < hashes.length; offset += 100) {
        const rows = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
          projectId: input.projectId,
          owner: user.subject,
          generationId: input.generationId,
          keys: hashes.slice(offset, offset + 100).map(key => ({ collection: 'sourceBlobs', key })),
        });
        for (const row of rows) {
          invariant(row, 'SOURCE_UNAVAILABLE', 'Changed file source is unavailable.');
          const p = JSON.parse(row.value) as Pin;
          blobs.set(p.sha256, { sha256: p.sha256, size: p.size });
        }
      }
      const counts = await compareCounts(ctx, {
        projectId: input.projectId,
        actor: user.subject,
        files: paths.map(f => ({
          ...(f.before ? { before: blobs.get(f.before.blob)! } : {}),
          ...(f.after ? { after: blobs.get(f.after.blob)! } : {}),
        })),
      });
      return await ctx.runMutation(internal.projectViewDiffstatStore.save, {
        ...request,
        base: selected.base,
        head: selected.head,
        stats: {
          files: paths.length,
          ...(counts.exact ? { add: counts.add, del: counts.del } : {}),
          exact: counts.exact,
          provenance: 'server-computed',
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});
