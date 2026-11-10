// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Id, Doc } from './_generated/dataModel';
import { githubInput } from '../src/github';
import { beginGithubSource } from '../src/github-project-source';
import { listGithubTree } from '../src/github-archive-source';
import { lfsImportMaxBytes } from '../src/github-import-pages';
import { importReadToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { networkFetch } from '../src/network-fetch';
import { ImportRequestMeter } from '../src/github-import-meter';
import { authorizeGithub } from '../src/github-access';
import { githubConfig } from './access';
import { invariant } from '../src/errors';
import { storeListing } from './projectGithubImportListing';
import { report } from './errors';
import { githubImportError, githubRequests } from './projectGithubImportFields';

export const start = action({
  args: {
    operationId: v.string(),
    url: v.string(),
    ref: v.optional(v.string()),
    name: v.optional(v.string()),
    /** Unique Git LFS bytes to fetch (default 1 GiB, at most 8 GiB); 0 keeps pointers. */
    lfsLimitBytes: v.optional(v.number()),
  },
  returns: v.id('projectGithubImports'),
  handler: async (ctx, input): Promise<Id<'projectGithubImports'>> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to import a project.');
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Use an original operation UUID.',
      );
      invariant(
        input.lfsLimitBytes === undefined ||
          (Number.isSafeInteger(input.lfsLimitBytes) &&
            input.lfsLimitBytes >= 0 &&
            input.lfsLimitBytes <= lfsImportMaxBytes),
        'BAD_ARGUMENT',
        'lfsLimitBytes is a whole number of bytes from 0 to 8 GiB.',
      );
      const parsed = githubInput(input.url),
        ref = input.ref || parsed.ref;
      const request = JSON.stringify([
        'github-project',
        parsed.repository,
        ref ?? null,
        input.name?.trim() ?? null,
        // Present only when chosen, so earlier requests keep their identity.
        ...(input.lfsLimitBytes === undefined ? [] : [input.lfsLimitBytes]),
      ]);
      const key = { actor: user.subject, operationId: input.operationId, request };
      const existing: Doc<'projectGithubImports'> | null = await ctx.runQuery(
        internal.projectGithubImportStore.lookup,
        key,
      );
      if (existing) {
        await ctx.runMutation(internal.projectGithubImportStore.resume, {
          id: existing._id,
          actor: user.subject,
        });
        return existing._id;
      }
      const meter = new ImportRequestMeter(undefined);
      const access = await authorizeGithub(
        parsed.repository,
        user.subject,
        githubConfig(),
        meter.wrap(networkFetch),
      );
      // Reads go on the Forge App's own quota when it is installed on the
      // repository; the importer's credential then only proves their access.
      const token =
        (await importReadToken(
          access.repository.full_name,
          (access.repository as { id?: unknown }).id,
          meter.wrap(convexFetch),
        )) ?? access.token;
      const source = await beginGithubSource(
        access.repository.full_name,
        ref ?? access.repository.default_branch,
        token,
        meter.wrap(networkFetch),
      );
      // One recursive listing decides the transfer: a complete tree streams the
      // commit archive; a truncated one keeps directory-by-directory discovery.
      const listing = await listGithubTree(
        source.repository,
        source.pending[0]!.sha,
        token,
        meter.wrap(networkFetch),
      );
      const begun = await ctx.runMutation(internal.projectGithubImportStore.begin, {
        ...(listing
          ? {
              archive: {
                total: listing.length,
                totalBytes: listing.totalBytes,
                submodules: listing.submodules,
              },
            }
          : {}),
        ...key,
        ...(input.lfsLimitBytes === undefined ? {} : { lfsLimitBytes: input.lfsLimitBytes }),
        name: input.name?.trim() || access.repository.full_name.split('/').at(-1)!,
        repository: source.repository,
        commit: source.commit,
        at: new Date().toISOString(),
        cursor: '',
        rootTree: source.pending[0]!.sha,
        visibility: access.repository.private ? 'private' : 'public',
        githubRequests: meter.counts,
      });
      // The listing is paid for once: its file table is kept in R2 and every archive step reads it.
      if (listing)
        await ctx.runMutation(internal.projectGithubImportStore.pinListing, {
          id: begun.id,
          actor: user.subject,
          listing: await storeListing(begun.projectId, source.pending[0]!.sha, listing),
        });
      return begun.id;
    } catch (error) {
      return report(error);
    }
  },
});
export const status = action({
  args: { id: v.id('projectGithubImports') },
  returns: v.object({
    projectId: v.id('hostedProjects'),
    commit: v.string(),
    phase: v.string(),
    completed: v.number(),
    total: v.number(),
    totalKnown: v.boolean(),
    bytes: v.number(),
    totalBytes: v.number(),
    submodules: v.number(),
    report: v.string(),
    error: v.union(githubImportError, v.null()),
    /** GitHub REST requests so far, by who paid; null for imports started before counting. */
    githubRequests: v.union(githubRequests, v.null()),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to read import progress.');
      const job: Doc<'projectGithubImports'> = await ctx.runQuery(internal.projectGithubImportStore.get, {
        ...input,
        actor: user.subject,
      });
      return {
        projectId: job.projectId,
        commit: job.commit,
        phase: job.phase,
        completed: job.completed,
        total: job.total,
        totalKnown: job.totalKnown,
        bytes: job.bytes,
        totalBytes: job.totalBytes,
        submodules: job.submodules ?? 0,
        report: `${job.submodules ?? 0} submodules kept as pointers`,
        error: job.error ?? null,
        githubRequests: job.githubRequests ?? null,
      };
    } catch (error) {
      return report(error);
    }
  },
});
