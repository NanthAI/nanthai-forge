// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { exchangeObjectReader } from './projectExchangeReader';
import { analyzeCrossHeadReuse } from '../src/hosted-cross-head-analysis';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError } from '../src/errors';
export const prove = internalAction({
  args: { projectId: v.id('hostedProjects'), submissionId: v.string(), pendingId: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const identity = { projectId: input.projectId, submissionId: input.submissionId };
    const context = await ctx.runQuery(
      makeFunctionReference<'query'>('projectHostedReuseStore:context'),
      identity,
    );
    if (!context || context.pendingId !== input.pendingId) return null;
    const owner: string | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedReuseStore:claim'),
      { ...input, owner: crypto.randomUUID() },
    );
    if (!owner) return null;
    let renewedAt = Date.now();
    const renew = async () => {
      if (Date.now() - renewedAt < 15_000) return;
      const held = await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedReuseStore:renew'), {
        ...input,
        owner,
      });
      if (!held) throw new ForgeError('WORK_STALE', 'The proof analysis lease changed.');
      renewedAt = Date.now();
    };
    const reader = exchangeObjectReader(ctx, false, 0);
    let proof = null;
    try {
      proof = await analyzeCrossHeadReuse(context.basis, context.selection, async (digests, consume) => {
        await renew();
        const rows = await ctx.runQuery(makeFunctionReference<'query'>('projectHostedReuseStore:objects'), {
          ...identity,
          digests,
        });
        // Source remains available for the exact recheck even when too large for
        // this optimization's analysis window.
        if (rows.some((row: { object: { size: number } }) => row.object.size > 2 * 1024 * 1024))
          throw new ForgeError('SOURCE_UNAVAILABLE', 'Impact analysis window unavailable.');
        const result: Buffer[] = [];
        for (let at = 0; at < rows.length;) {
          await renew();
          let end = at,
            bytes = 0;
          while (end < rows.length && bytes + rows[end].object.size <= 2 * 1024 * 1024)
            bytes += rows[end++].object.size;
          const window = await reader.read(
            input.projectId,
            context.actor,
            rows.slice(at, end).map((row: { object: { sha256: string; size: number } }) => row.object),
          );
          if (consume) {
            for (let i = at; i < end; i++) await consume(rows[i].object.sha256, window[i - at]!);
          } else result.push(...window);
          at = end;
        }
        return result;
      });
    } catch (error) {
      // No partial certificate authorizes reuse. Transport/parse/coverage errors
      // retain the normal exact check, rather than failing the landing.
      if (!(error instanceof Error)) throw error;
      if (error instanceof ForgeError && error.code === 'WORK_STALE') return null;
    }
    await renew();
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedReuseStore:complete'), {
      ...input,
      owner,
      proof: proof ? canonicalPayload(proof) : null,
    });
    return null;
  },
});
