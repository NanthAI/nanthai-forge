// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { installationTokenMinter, mirrorPermissionsFor } from './githubAppToken';
import { projectSource } from './projectGithubMirror';
import { githubRequest, type GithubRequest } from '../src/hosted-github-api';
import {
  prepareMirror,
  stepMirror,
  type MirrorIO,
  type MirrorPlan,
  type MirrorSeed,
} from '../src/hosted-github-mirror';
import { lfsBatch, uploadLfsObject } from '../src/github-lfs';
import { unexpectedMirrorFailure } from '../src/hosted-github-retry';
import { ForgeError, invariant } from '../src/errors';

const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
/** Mirror steps one publish may take; a Candidate over this many 100-blob windows fails visibly. */
const publishSteps = 8;

/** Publishes one ci-status run's Candidate as `forge/candidates/<runId>` with the mirror's own Git
 * data API push (src/hosted-github-mirror.ts): changed blobs, one tree, one commit, one new ref. The
 * branch is created once and never moved, so a replay finds its commit and writes nothing new. */
export const publish = internalAction({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const raw: string | null = await ctx.runMutation(mutation('projectCiStatus:prepare'), input);
    if (!raw) return null;
    const seed = JSON.parse(raw) as MirrorSeed;
    let token = '';
    try {
      let plan: MirrorPlan | undefined;
      const mint = await installationTokenMinter(ctx, input.projectId, seed.repository);
      let client: Promise<GithubRequest> | undefined;
      const apiClient = () =>
        (client ??= mint(mirrorPermissionsFor(plan)).then(minted => {
          token = minted;
          return githubRequest(minted);
        }));
      const api: GithubRequest = async <T>(path: string, method?: string, body?: unknown): Promise<T> =>
        (await apiClient())<T>(path, method, body);
      const io: MirrorIO = {
        ...projectSource(ctx, digests =>
          ctx.runQuery(internal.gitServeLaneStore.resolve, { projectId: input.projectId, digests }),
        ),
        api,
        lfs: {
          batch: async objects => {
            await apiClient();
            return lfsBatch(seed.repository, 'upload', objects, token);
          },
          upload: async (object, bytes) => {
            await apiClient();
            await uploadLfsObject(object, bytes, token);
          },
        },
      };
      plan = await prepareMirror(seed, io);
      for (let step = 0; plan.phase !== 'done'; step++) {
        invariant(
          step < publishSteps,
          'GITHUB_SYNC_API',
          'The Candidate is too large to publish in one action.',
        );
        plan = await stepMirror(plan, io);
      }
      await ctx.runMutation(mutation('projectCiStatus:published'), { ...input, commit: plan.entry!.commit });
    } catch (error) {
      // A named Forge error keeps its code and message (never a token); anything else is bounded.
      const failure =
        error instanceof ForgeError
          ? { code: error.code, detail: error.message }
          : unexpectedMirrorFailure(error, [token]);
      await ctx.runMutation(mutation('projectCiStatus:failed'), {
        ...input,
        reason: `${failure.code}: ${failure.detail}`.slice(0, 400),
      });
    }
    return null;
  },
});
