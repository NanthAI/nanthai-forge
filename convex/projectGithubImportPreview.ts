// SPDX-License-Identifier: Apache-2.0
'use node';
// The pre-import report (Item a488af2a): the same reads `projectGithubImport:start` makes before it creates
// anything (repository access, the commit, one recursive listing), returned instead of acted on. No project,
// job or row is written; refusals the listing finds (non-UTF-8 paths, unsupported modes, files GitHub cannot
// return) arrive here, before any work begins.
import { v } from 'convex/values';
import { accountAction } from './cliServer';
import { githubInput } from '../src/github';
import { beginGithubSource } from '../src/github-project-source';
import { listGithubTree } from '../src/github-archive-source';
import { importReadToken } from './githubAppToken';
import { convexFetch } from './networkFetch';
import { networkFetch } from '../src/network-fetch';
import { ImportRequestMeter } from '../src/github-import-meter';
import { authorizeImportGithub } from './githubImportAccess';
import { invariant } from '../src/errors';
import { report } from './errors';
import { githubRequests } from './projectGithubImportFields';
import {
  importEnvelopeWarnings,
  importLfsLine,
  importVisibilityChoices,
  type ImportPreview,
} from '../src/github-import-report';

const visibility = v.union(v.literal('public'), v.literal('private'));
export const preview = accountAction('same')({
  args: { url: v.string(), ref: v.optional(v.string()) },
  returns: v.object({
    repository: v.string(),
    origin: visibility,
    choices: v.array(visibility),
    ref: v.string(),
    commit: v.string(),
    files: v.union(v.number(), v.null()),
    bytes: v.union(v.number(), v.null()),
    submodules: v.union(v.number(), v.null()),
    attributes: v.union(v.number(), v.null()),
    lfs: v.string(),
    warnings: v.array(v.object({ code: v.union(v.string(), v.null()), message: v.string() })),
    githubRequests,
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to import a project.');
      const parsed = githubInput(input.url);
      const meter = new ImportRequestMeter(undefined);
      const access = await authorizeImportGithub(
        parsed.repository,
        user.subject,
        meter.wrap(networkFetch),
        ctx,
      );
      const token =
        (await importReadToken(
          access.repository.full_name,
          (access.repository as { id?: unknown }).id,
          meter.wrap(convexFetch),
        )) ?? access.token;
      const ref = input.ref || parsed.ref || access.repository.default_branch;
      const source = await beginGithubSource(
        access.repository.full_name,
        ref,
        token,
        meter.wrap(networkFetch),
      );
      const listing = await listGithubTree(
        source.repository,
        source.pending[0]!.sha,
        token,
        meter.wrap(networkFetch),
      );
      let attributes: number | null = null;
      if (listing) {
        attributes = 0;
        for (let i = 0; i < listing.length; i++)
          if (listing.path(i).split('/').at(-1) === '.gitattributes') attributes++;
      }
      const origin = access.repository.private ? 'private' : 'public';
      const result: ImportPreview = {
        repository: access.repository.full_name,
        origin,
        choices: importVisibilityChoices(origin),
        ref,
        commit: source.commit,
        files: listing?.length ?? null,
        bytes: listing?.totalBytes ?? null,
        submodules: listing?.submodules ?? null,
        attributes,
        lfs: importLfsLine(attributes),
        warnings: importEnvelopeWarnings(listing?.length ?? null),
      };
      return { ...result, githubRequests: meter.counts };
    } catch (error) {
      return report(error);
    }
  },
});
