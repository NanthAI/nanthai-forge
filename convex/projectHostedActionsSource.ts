// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { sourceObjectLocation } from './projectSourceBeginReads';
import { actionsSourceStates } from './projectStateSourceSelection';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { isStored } from './projectObjectFields';
import { presignGet, r2Config } from './r2';
import { blobStore } from './blobStore';
import { directSourceWindow, directSourceBatch } from '../src/hosted-actions-direct';
import { invariant } from '../src/errors';
import { findObjects } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
import { signRecipeClosure } from './projectRecipeClosure';
import { signRuns, type RunBinding } from './projectObjectRuns';
import type { ObjectPack } from '../src/object-pack-range';
/** One bounded descriptor+GET window. Bytes go storage→runner, never via Convex. */
export const resolve = internalMutation({
  args: {
    ...sessionArgs,
    digests: v.array(v.string()),
    batch: v.optional(v.literal(true)),
    closures: v.optional(v.literal(true)),
    runs: v.optional(v.literal(true)),
    bound: v.optional(v.literal(true)),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input, false);
    let packState: string | undefined;
    if (input.bound) {
      const scope = await actionsSourceStates(ctx, input.projectId, run);
      const allowed = scope.allowed;
      packState = scope.packState;
      invariant(
        input.digests.every(id => allowed.has(id)),
        'SOURCE_UNAVAILABLE',
        'State is outside this run.',
      );
    }
    let physical: { state: string; pin: { sha256: string; size: number } } | undefined;
    invariant(
      input.digests.length > 0 &&
        input.digests.length <= (input.batch ? directSourceBatch : directSourceWindow),
      'BAD_ARGUMENT',
      'Resolve one source window.',
    );
    const result: {
      descriptor: {
        object: { sha256: string; size: number };
        recipe: { sha256: string; size: number } | null;
      };
      url: string | null;
      range?: { offset: number; total: number };
      closure?: Awaited<ReturnType<typeof signRecipeClosure>>;
      run?: RunBinding;
      statePhysical?: { sha256: string; size: number };
    }[] = [];
    const packed: { index: number; size: number; pack: ObjectPack; key: string }[] = [];
    const reply = async () => {
      const extraStates = [];
      if (input.bound && packState && !input.digests.includes(packState)) {
        const row = await findObjects(ctx, input.projectId, [packState]);
        if (row[0] && !row[0].removed && isStored(row[0])) {
          const location = await sourceObjectLocation(ctx, input.projectId, {
            sha256: packState,
            size: row[0].size,
          });
          const url =
            location.url ?? (location.storageId ? await blobStore(ctx).getUrl(location.storageId) : null);
          extraStates.push({
            descriptor: location.descriptor,
            ...(location.statePhysical ? { statePhysical: location.statePhysical } : {}),
            url,
            ...(location.range ? { range: location.range } : {}),
            ...(location.closure ? { closure: location.closure } : {}),
          });
        }
      }
      for (;;) {
        if (input.runs) await signRuns(result, packed);
        const text = JSON.stringify(result);
        const bytes = new TextEncoder().encode(text).length;
        if (!input.batch || result.length === 1 || bytes <= 4 * 1024 * 1024)
          return input.bound
            ? JSON.stringify({
                rows: result,
                ...(physical ? { physical } : {}),
                ...(extraStates.length ? { extraStates } : {}),
              })
            : input.batch
              ? text
              : result;
        // Keep the existing bounded-prefix protocol even with unusually long
        // storage URLs. Re-sign only retained members, so no run gets split.
        result.length = Math.max(1, Math.floor((result.length * (4 * 1024 * 1024 - 1024)) / bytes));
        while (packed.length && packed.at(-1)!.index >= result.length) packed.pop();
        for (const row of packed) {
          result[row.index]!.url = null;
          delete result[row.index]!.run;
        }
      }
    };
    let sourceBytes = 0;
    let replyBytes = 2;
    invariant(
      input.digests.every(digest => /^[a-f0-9]{64}$/.test(digest)),
      'BAD_ARGUMENT',
      'Select exact source hashes.',
    );
    // A sparse historical catalog can cost two index reads per digest. Leave room
    // for the next 100 lookups and catalog pages; continue in a fresh transaction
    // instead of retrying a deterministic transaction-limit failure.
    for (let start = 0; start < input.digests.length; start += 100) {
      // Keep large-file grants as close to use as the legacy 400-object path.
      if (input.batch && start >= directSourceWindow && sourceBytes >= 8 * 1024 * 1024) break;
      if (input.batch && start) {
        const remaining = await ctx.meta.getTransactionMetrics();
        if (remaining.databaseQueries.remaining < 512 || remaining.bytesRead.remaining < 4 * 1024 * 1024)
          break;
      }
      const rows = await findObjects(ctx, input.projectId, input.digests.slice(start, start + 100));
      for (const row of rows) {
        invariant(
          row && !row.removed && isStored(row),
          'SOURCE_UNAVAILABLE',
          'Exact project object is unavailable.',
        );
        if (input.bound && row.digest === run.request.expectedHead && row.statePhysical)
          physical = { state: row.digest, pin: row.statePhysical };
        sourceBytes += row.size;
        const url =
          input.runs && row.pack && row.location === 'r2' && row.r2Key
            ? null
            : row.location === 'r2' && row.r2Key
              ? await presignGet(r2Config(), row.r2Key, packHeaders(packRange(row), row.size))
              : row.storageId
                ? await blobStore(ctx).getUrl(row.storageId)
                : null;
        invariant(
          url || row.recipe || (input.runs && row.pack && row.r2Key),
          'SOURCE_UNAVAILABLE',
          'Source storage binding is unavailable.',
        );
        const value = {
          ...(input.bound && row.statePhysical ? { statePhysical: row.statePhysical } : {}),
          descriptor: {
            object: { sha256: row.digest, size: row.size },
            recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
          },
          url,
          ...(row.pack ? { range: packRange(row)! } : {}),
          ...(input.batch && input.closures && row.recipe && row.recipeClosure
            ? { closure: await signRecipeClosure(row) }
            : {}),
        };
        // Signed leaves can outweigh their parent descriptor. Keep the existing
        // prefix protocol below the Convex value limit without capping the tree.
        const bytes = new TextEncoder().encode(JSON.stringify(value)).length + 1;
        if (input.batch && result.length && replyBytes + bytes > 4 * 1024 * 1024) return reply();
        if (input.runs && row.pack && row.location === 'r2' && row.r2Key)
          packed.push({ index: result.length, size: row.size, pack: row.pack, key: row.r2Key });
        result.push(value);
        replyBytes += bytes;
      }
    }
    return reply();
  },
});
