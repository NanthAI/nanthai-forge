// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action, accountAction } from './cliServer';
import { internal } from './_generated/api';
import type { Id, Doc } from './_generated/dataModel';
import { githubInput } from '../src/github';
import { beginGithubSource } from '../src/github-project-source';
import { listGithubTree } from '../src/github-archive-source';
import { githubMigrationCounts } from '../src/github-migration-ledger';
import { lfsImportMaxBytes } from '../src/github-import-pages';
import { importReadToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { networkFetch } from '../src/network-fetch';
import { ImportRequestMeter } from '../src/github-import-meter';
import { authorizeImportGithub } from './githubImportAccess';
import { invariant } from '../src/errors';
import { storeListing } from './projectGithubImportListing';
import { report } from './errors';
import { githubImportError, githubRequests, migrationCounts } from './projectGithubImportFields';

export const start = accountAction('write')({
  args: {
    operationId: v.string(),
    url: v.string(),
    ref: v.optional(v.string()),
    name: v.optional(v.string()),
    /** Unique Git LFS bytes to fetch (default 1 GiB, at most 8 GiB); 0 keeps pointers. */
    lfsLimitBytes: v.optional(v.number()),
    /** The project's visibility here; absent keeps GitHub's. A public repository may import private. */
    visibility: v.optional(v.union(v.literal('public'), v.literal('private'))),
    /** On a replay of a job paused by a provider limit: resume at the recorded reset, not now. */
    atReset: v.optional(v.boolean()),
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
        ...(input.visibility === undefined ? [] : [{ visibility: input.visibility }]),
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
          ...(input.atReset ? { atReset: true } : {}),
        });
        return existing._id;
      }
      const meter = new ImportRequestMeter(undefined);
      const access = await authorizeImportGithub(
        parsed.repository,
        user.subject,
        meter.wrap(networkFetch),
        ctx,
      );
      invariant(
        input.visibility !== 'public' || !access.repository.private,
        'BAD_ARGUMENT',
        `${access.repository.full_name} is private on GitHub, so it imports private. Leave visibility out or choose private.`,
      );
      // Reads go on the Forge App's own quota when it is installed on the
      // repository; the importer's credential then only proves their access.
      const token =
        (await importReadToken(
          access.repository.full_name,
          (access.repository as { id?: unknown }).id,
          meter.wrap(convexFetch),
        )) ?? access.token;
      const migrationPending =
        process.env.FORGE_MIGRATION_LEDGER === '1'
          ? githubMigrationCounts(access.repository.full_name, token, meter.wrap(networkFetch))
          : undefined;
      const source = await beginGithubSource(
        access.repository.full_name,
        ref ?? access.repository.default_branch,
        token,
        meter.wrap(networkFetch),
      );
      // One recursive listing decides the transfer: a complete tree streams the
      // commit archive; a truncated one keeps directory-by-directory discovery.
      const [listing, migration] = await Promise.all([
        listGithubTree(source.repository, source.pending[0]!.sha, token, meter.wrap(networkFetch)),
        migrationPending,
      ]);
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
        visibility: input.visibility ?? (access.repository.private ? 'private' : 'public'),
        githubRequests: meter.counts,
        ...(migration ? { migration } : {}),
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
    /** The project's visibility here, as chosen at import (GitHub's when nothing was chosen). */
    visibility: v.union(v.literal('public'), v.literal('private')),
    phase: v.string(),
    completed: v.number(),
    total: v.number(),
    totalKnown: v.boolean(),
    bytes: v.number(),
    totalBytes: v.number(),
    submodules: v.number(),
    report: v.string(),
    error: v.union(githubImportError, v.null()),
    /** GitHub API requests so far, by who paid; null for imports started before counting. */
    githubRequests: v.union(githubRequests, v.null()),
    migration: v.optional(migrationCounts),
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
        visibility: job.visibility,
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
        ...(job.migration ? { migration: job.migration } : {}),
      };
    } catch (error) {
      return report(error);
    }
  },
});
