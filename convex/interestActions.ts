// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { interestReceipt, interestUpdate } from './schema';
import { currentAccess } from './access';
import { githubJson } from '../src/github';
import { identity } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';

export const change = action({
  args: {
    importId: v.id('imports'),
    operationId: v.string(),
    expectedRevision: v.number(),
    update: interestUpdate,
  },
  returns: v.object(interestReceipt),
  handler: async (ctx, input): Promise<Omit<Doc<'interestChanges'>, '_id' | '_creationTime'>> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage personal stars and watches.');
      invariant(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.operationId) &&
          Number.isSafeInteger(input.expectedRevision) &&
          input.expectedRevision >= 0,
        'BAD_ARGUMENT',
        'Send the original operation UUID and observed star/watch revision.',
      );
      invariant(
        input.update.kind !== 'seen' || /^[a-f0-9]{40,64}$/.test(input.update.head),
        'BAD_ARGUMENT',
        'Choose the displayed watched revision.',
      );
      const owner = user.subject,
        request = identity(input),
        old = await ctx.runQuery(internal.interests.receipt, { owner, operationId: input.operationId });
      if (old) {
        invariant(
          old.request === request,
          'INTEREST_OPERATION_CHANGED',
          'Reconcile the original star/watch request.',
        );
        return old;
      }
      let metadata: { repository?: string; ref?: string; head?: string } = {};
      if (input.update.kind === 'seen' || input.update.value) {
        const access = await currentAccess(ctx, input.importId, owner);
        metadata = { repository: access.job.repository, ref: access.job.ref };
        if (input.update.kind === 'watch') {
          const latest = await githubJson<{ sha: string }>(
            `/repos/${access.repository.full_name}/commits/${encodeURIComponent(access.job.ref)}`,
            access.token,
          );
          invariant(
            /^[a-f0-9]{40,64}$/.test(latest.sha),
            'GITHUB_RESPONSE',
            'GitHub returned an invalid source revision.',
          );
          metadata.head = latest.sha;
        }
        await currentAccess(ctx, input.importId, owner);
      }
      return await ctx.runMutation(internal.interests.change, { ...input, owner, request, ...metadata });
    } catch (error) {
      return report(error);
    }
  },
});
export const observe = action({
  args: { importId: v.id('imports') },
  returns: v.object({ head: v.string(), indexedHead: v.union(v.string(), v.null()), checkedAt: v.number() }),
  handler: async (
    ctx,
    { importId },
  ): Promise<{ head: string; indexedHead: string | null; checkedAt: number }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to check a watched revision.');
      const access = await currentAccess(ctx, importId, user.subject);
      const latest = await githubJson<{ sha: string }>(
        `/repos/${access.repository.full_name}/commits/${encodeURIComponent(access.job.ref)}`,
        access.token,
      );
      invariant(
        /^[a-f0-9]{40,64}$/.test(latest.sha),
        'GITHUB_RESPONSE',
        'GitHub returned an invalid source revision.',
      );
      const current = await currentAccess(ctx, importId, user.subject);
      invariant(
        current.job.ref === access.job.ref && current.job.repository === access.job.repository,
        'INTEREST_CHANGED',
        'The import changed during this check.',
      );
      return { head: latest.sha, indexedHead: current.job.head ?? null, checkedAt: Date.now() };
    } catch (error) {
      return report(error);
    }
  },
});
