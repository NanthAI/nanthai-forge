// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { readJobState } from './projectGithubImportRead';
import { githubImportError } from './projectGithubImportFields';
import { invariant } from '../src/errors';

/** A project-owner subscription, invalidated by import writes, never a timer.
 * A stopped worker task reads as a resumable failure. */
export const current = query({
  args: { id: v.id('projectGithubImports') },
  returns: v.object({
    projectId: v.id('hostedProjects'),
    phase: v.string(),
    completed: v.number(),
    total: v.number(),
    error: v.union(githubImportError, v.null()),
  }),
  handler: async (ctx, { id }) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'AUTH_REQUIRED', 'Sign in to read import progress.');
    const job = await readJobState(ctx, { id, actor: user.subject });
    return {
      projectId: job.projectId,
      phase: job.phase,
      completed: job.completed,
      total: job.total,
      error: job.error ?? null,
    };
  },
});
