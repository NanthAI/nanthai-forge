// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { commitObjects } from './projectObjectCommit';
import { runConvexSourceStep } from './projectConvexSource';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One call per save, sync or compose job (contract feature source-submit-run): commit the caller's
 * deferred uploads, submit with the dispatch in the same transaction, and run the first step here
 * instead of waiting for the scheduler. The step keeps its own budgets: a job it does not finish
 * continues on scheduled steps as before. The submit records a delayed fallback for that step, so a
 * lost action still completes; its commit cancels the fallback. Returns the submit receipt. */
export const submit = action({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    kind: v.union(v.literal('save'), v.literal('sync'), v.literal('compose')),
    /** Raw uploads to commit first (at most 100), as `projectObjectCommit:commitBatch` takes them. */
    objects: v.optional(v.array(v.object({ id: v.id('projectObjects') }))),
    /** A save's last delta page (save-submit-page). */
    index: v.optional(v.number()),
    page: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to submit hosted source.');
      const { objects, ...submit } = input;
      if (objects?.length) await commitObjects(ctx, user.subject, objects);
      const submitted: { payload: string; run: string | null } = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectSourceRunStore:submit'), {
          ...submit,
          actor: user.subject,
        }),
      );
      if (submitted.run)
        try {
          await runConvexSourceStep(ctx, { projectId: input.projectId, jobId: submitted.run, step: 0 });
        } catch {
          // The step recorded its failure; the scheduled fallback retries it and observation reports it.
        }
      return submitted.payload;
    } catch (error) {
      return report(error);
    }
  },
});
