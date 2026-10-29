// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { artifactBlobId } from './artifactBlobFields';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { currentAccess } from './access';
import { captureGithub, githubJson, githubAnalysisVersion } from '../src/github';
import { encodeHostedArtifact } from '../src/hosted-artifact';
import { ForgeError } from '../src/errors';

// Bump the acquisition version when capture semantics change.
const analysisVersion = githubAnalysisVersion();
export const run = internalAction({
  args: { id: v.id('imports'), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, generation }): Promise<null> => {
    let stored: string | undefined;
    try {
      const job = await ctx.runQuery(internal.imports.get, { id });
      if (!job || job.removal || job.generation !== generation) return null;
      const access = await currentAccess(ctx, id, job.owner || undefined);
      await ctx.runMutation(internal.imports.update, { id, generation, phase: 'fetching' });
      if (job.artifactKey && job.analysisVersion === analysisVersion) {
        const latest = await githubJson<{ sha: string }>(
          `/repos/${access.repository.full_name}/commits/${encodeURIComponent(job.ref)}`,
          access.token,
        );
        if (latest.sha === job.head) {
          await ctx.runMutation(internal.imports.update, { id, generation, phase: 'ready' });
          return null;
        }
      }
      const remote = process.env.NETLIFY_WORKER_URL;
      if (!access.repository.private && remote) {
        if (!process.env.FORGE_WORKER_KEY)
          throw new ForgeError('WORKER_SETUP_REQUIRED', 'Forge’s analysis worker is not configured yet.');
        if (!(await ctx.runMutation(internal.imports.handoff, { id, generation }))) return null;
        const response = await fetch(remote, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${process.env.FORGE_WORKER_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ id, generation }),
        });
        if (response.status !== 202)
          throw new ForgeError(
            'WORKER_UNAVAILABLE',
            'The analysis worker could not start. Retry to rebuild; previous source is retained.',
          );
        return null;
      }
      const artifact = await captureGithub(
        access.repository,
        job.ref,
        access.token,
        async (processed, total) => {
          await ctx.runMutation(internal.imports.update, {
            id,
            generation,
            phase: processed === total ? 'indexing' : 'fetching',
            processed,
            total,
          });
        },
      );
      stored = await blobStore(ctx).store(await encodeHostedArtifact(artifact), {
        r2Namespace: `v1/i/${id}/g/${generation}`,
      });
      await currentAccess(ctx, id, job.owner || undefined);
      const published = await ctx.runMutation(internal.imports.update, {
        id,
        generation,
        phase: 'ready',
        artifactKey: stored,
        head: artifact.pack.source.gitHead!,
        analysisVersion,
      });
      if (
        !published &&
        (!artifactBlobId(stored) ||
          !(await ctx.runQuery(internal.imports.artifactInUse, { artifactKey: stored })))
      )
        await blobStore(ctx).delete(stored);
    } catch (error) {
      // Reconcile an uncertain publication before deleting its object.
      const current = await ctx.runQuery(internal.imports.get, { id });
      if (stored && current?.artifactKey === stored) return null;
      if (
        stored &&
        (!artifactBlobId(stored) ||
          !(await ctx.runQuery(internal.imports.artifactInUse, { artifactKey: stored })))
      )
        await blobStore(ctx).delete(stored);
      await ctx.runMutation(internal.imports.update, {
        id,
        generation,
        phase: 'error',
        error:
          error instanceof ForgeError
            ? error.message
            : 'Import failed. Retry to rebuild; previous source is retained.',
      });
    }
    return null;
  },
});
