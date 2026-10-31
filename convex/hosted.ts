// SPDX-License-Identifier: Apache-2.0
'use node';
import { paginationOptsValidator } from 'convex/server';
import { ForgeError } from '../src/errors';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { currentAccess, githubConfig } from './access';
import { authorizeGithub } from '../src/github-access';
import { githubInput, githubJson } from '../src/github';
import { derivedArtifact, derivedBytes } from './derivedArtifactActions';
import { hostedStatus, type HostedStatus } from '../src/hosted-status';
import { indexedHostedQuery } from './hostedQueryIndex';
import { invariant } from '../src/errors';
import { report } from './errors';

export const start = action({
  args: { url: v.string(), ref: v.optional(v.string()) },
  returns: v.id('imports'),
  handler: async (ctx, { url, ref }): Promise<Id<'imports'>> => {
    try {
      const input = githubInput(url);
      const user = await ctx.auth.getUserIdentity();
      const access = await authorizeGithub(input.repository, user?.subject, githubConfig());
      const result = await ctx.runMutation(internal.imports.begin, {
        repository: access.repository.full_name,
        ref: ref || input.ref || access.repository.default_branch,
        owner: user?.subject ?? '',
        visibility: access.repository.private ? 'private' : 'public',
      });
      return result.id;
    } catch (error) {
      return report(error);
    }
  },
});
export const status = action({
  args: { id: v.id('imports') },
  returns: v.string(),
  handler: async (ctx, { id }): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      const { job, repository } = await currentAccess(ctx, id, user?.subject);
      return JSON.stringify({
        id: job._id,
        repository: repository.full_name,
        ref: job.ref,
        visibility: repository.private ? 'private' : 'public',
        phase: job.phase,
        processed: job.processed,
        total: job.total,
        error: job.error,
        sync: job.sync,
        canRefresh: (job.visibility === 'public' && !repository.private) || job.owner === user?.subject,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const refresh = action({
  args: { id: v.id('imports') },
  returns: v.id('imports'),
  handler: async (ctx, { id }): Promise<Id<'imports'>> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      const { job, repository } = await currentAccess(ctx, id, user?.subject, false, true);
      const result = await ctx.runMutation(internal.imports.begin, {
        repository: repository.full_name,
        ref: job.ref,
        owner: user?.subject ?? '',
        visibility: repository.private ? 'private' : 'public',
      });
      return result.id;
    } catch (error) {
      return report(error);
    }
  },
});
export async function readSource(
  ctx: ActionCtx,
  { id, endpoint }: { id: Id<'imports'>; endpoint: string },
): Promise<string> {
  try {
    const user = await ctx.auth.getUserIdentity();
    const { job, repository, token } = await currentAccess(ctx, id, user?.subject);
    invariant(job.artifactKey, 'INDEX_MISSING', 'This repository is still being indexed.');
    const isStatus = endpoint.split('?')[0] === 'status';
    const revision: number | null = isStatus ? await ctx.runMutation(internal.sync.begin, { id }) : null;
    const key = job.artifactKey;
    const latest = await githubJson<{ sha: string }>(
      `/repos/${repository.full_name}/commits/${encodeURIComponent(job.ref)}`,
      token,
    );
    invariant(
      /^[a-f0-9]{40,64}$/.test(latest.sha),
      'GITHUB_RESPONSE',
      'GitHub returned an invalid source revision.',
    );
    const stored = await derivedArtifact(
      ctx,
      key,
      isStatus ? 'hosted-status-v1' : 'hosted-query-v1',
      isStatus ? '' : JSON.stringify([id, job.head, endpoint, latest.sha]),
      async () => {
        const value = JSON.stringify(
          await indexedHostedQuery(
            ctx,
            key,
            isStatus ? 'status' : endpoint,
            isStatus ? job.head! : latest.sha,
            repository,
            () => currentAccess(ctx, id, user?.subject),
          ),
        );
        return Buffer.byteLength(value) <= 64_000 ? value : new Blob([value], { type: 'application/json' });
      },
      () => currentAccess(ctx, id, user?.subject),
    );
    invariant(stored, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
    const cached = JSON.parse(Buffer.from(await derivedBytes(ctx, stored)).toString('utf8'));
    let result: unknown;
    if (isStatus) {
      invariant(stored && 'original' in stored, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      result = hostedStatus(cached as HostedStatus, endpoint, latest.sha, repository);
    } else {
      result = cached;
    }
    await currentAccess(ctx, id, user?.subject);
    const observation = { checkedAt: Date.now(), result: 'checked' as const, head: latest.sha };
    if (revision !== null) await ctx.runMutation(internal.sync.finish, { id, revision, observation });
    return JSON.stringify(
      isStatus && result && typeof result === 'object' ? { ...result, sync: observation } : result,
    );
  } catch (error) {
    return report(error);
  }
}
export const read = action({
  args: { id: v.id('imports'), endpoint: v.string() },
  returns: v.string(),
  handler: readSource,
});

export const discover = action({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.string(),
  handler: async (ctx, { paginationOpts }): Promise<string> => {
    try {
      const candidates = await ctx.runQuery(internal.imports.publicPage, { paginationOpts });
      const page = [];
      let unavailable = 0;
      for (const id of candidates.page) {
        try {
          // Always anonymous authority, including signed-in callers. Personal access cannot publish private metadata.
          const { job, repository } = await currentAccess(ctx, id, undefined);
          const current = await ctx.runQuery(internal.imports.get, { id });
          invariant(
            !repository.private &&
              current?.visibility === 'public' &&
              !current.removal &&
              current.phase === 'ready' &&
              current.head &&
              current.artifactKey &&
              current.generation === job.generation &&
              current.head === job.head &&
              current.artifactKey === job.artifactKey &&
              current.repository === job.repository &&
              current.ref === job.ref,
            'GITHUB_UNAVAILABLE',
            'This public import changed during discovery.',
          );
          page.push({
            id,
            repository: repository.full_name,
            url: repository.html_url,
            ref: job.ref,
            head: job.head,
            importedAt: job._creationTime,
            checkedAt: Date.now(),
            license: repository.license,
          });
        } catch (error) {
          if (!(error instanceof ForgeError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
          unavailable++;
        }
      }
      return JSON.stringify({
        page,
        isDone: candidates.isDone,
        continueCursor: candidates.continueCursor,
        unavailable,
      });
    } catch (error) {
      return report(error);
    }
  },
});
