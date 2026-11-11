// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { projectSource } from './projectGithubMirror';
import { parseNativeState } from '../src/state/format';
import { convexFetch } from './networkFetch';
import { checkReportsKey } from './projectHostedCheckReports';
import { presignGet, r2Config } from './r2';
import { checkPin } from '../src/hosted-check';
import { semanticReportsSchema } from '../src/intent-semantic-conflict';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
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

export const reports = internalAction({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), namedRunId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const target = JSON.parse(
      await ctx.runQuery(makeFunctionReference<'query'>('projectHostedCulprit:reportTarget'), input),
    );
    if (!target.run?.reportPointer) return null;
    const run = target.run;
    const response = await convexFetch(await presignGet(r2Config(), checkReportsKey(run)));
    invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Compared check reports are unavailable.');
    const body = await response.text();
    const reports = semanticReportsSchema.parse(JSON.parse(body));
    invariant(
      new TextEncoder().encode(body).length === run.reportPointer.size &&
        checkPin(reports) === run.reportPointer.digest,
      'EVIDENCE_CHANGED',
      'Compared check reports differ from their pin.',
    );
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedCulprit:reportEvidence'), {
      projectId: input.projectId,
      runId: input.runId,
      evidence: canonicalPayload({
        runId: run.id,
        digest: run.reportPointer.digest,
        reports: Object.fromEntries(
          target.files.filter((file: string) => reports[file]).map((file: string) => [file, reports[file]]),
        ),
      }),
    });
    return null;
  },
});
