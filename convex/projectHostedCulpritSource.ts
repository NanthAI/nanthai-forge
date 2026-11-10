// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { projectSource } from './projectGithubMirror';
import { parseNativeState } from '../src/state/format';
import { ForgeError } from '../src/errors';

/** Reuse the recipe-aware hash-verified source reader, retaining only file presence. */
export const inspect = internalAction({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const query = makeFunctionReference<'query'>('projectHostedCulprit:source');
    const plan: { heads?: string[]; files?: string[] } = JSON.parse(await ctx.runQuery(query, input));
    if (!plan.heads || !plan.files) return null;
    const reader = projectSource(ctx, async digests => {
      const result: string = await ctx.runQuery(query, { ...input, digests });
      if (result === '{}')
        throw new ForgeError('WORK_STALE', 'The red episode changed during source attribution.');
      return result;
    });
    const presence: string[][] = [];
    try {
      for (let offset = 0; offset < plan.heads.length; offset += 100) {
        const blobs = await reader.blobs(plan.heads.slice(offset, offset + 100));
        for (const blob of blobs) {
          const state = parseNativeState(await blob.read());
          const paths = new Set(state.files.map(file => file.path));
          presence.push(plan.files.filter(file => paths.has(file)));
        }
      }
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedCulprit:sourceEvidence'), {
        ...input,
        error: `${error.code}: ${error.message}`,
      });
      return null;
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedCulprit:sourceEvidence'), {
      ...input,
      presence,
    });
    return null;
  },
});
