// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { exchangeObjectReader } from './projectExchangeReader';
import { analyzeCrossHeadReuse, type FirstCheckDecision } from '../src/hosted-cross-head-analysis';
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
    let decision: FirstCheckDecision = { reason: 'source-unavailable' };
    try {
      decision = await analyzeCrossHeadReuse(
        context.basis,
        context.selection,
        async digests => {
          await renew();
          const rows = await ctx.runQuery(makeFunctionReference<'query'>('projectHostedReuseStore:objects'), {
            ...identity,
            digests,
          });
          // Six small JSON documents (four manifests, two selection pins).
          if (rows.some((row: { object: { size: number } }) => row.object.size > 8 * 1024 * 1024))
            throw new ForgeError('SOURCE_UNAVAILABLE', 'Proof manifest unavailable.');
          return reader.read(
            input.projectId,
            context.actor,
            rows.map((row: { object: { sha256: string; size: number } }) => row.object),
          );
        },
        context.checkEntries,
        context.fast === true,
        context.exactTreeOnly === true,
      );
    } catch (error) {
      // No partial certificate authorizes reuse. Transport/parse errors retain the
      // normal recheck, rather than failing the landing.
      if (!(error instanceof Error)) throw error;
      if (error instanceof ForgeError && error.code === 'WORK_STALE') return null;
    }
    await renew();
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedReuseStore:complete'), {
      ...input,
      owner,
      proof: 'proof' in decision ? canonicalPayload(decision.proof) : null,
      ...('reason' in decision ? { reason: decision.reason } : {}),
    });
    return null;
  },
});
