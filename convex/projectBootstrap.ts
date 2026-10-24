// SPDX-License-Identifier: AGPL-3.0-only
'use node';
import { randomUUID } from 'node:crypto';
import { blobStore } from './blobStore';
import { v } from 'convex/values';
import { action } from './cliServer';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { emptyHostedProject } from '../src/hosted-bootstrap';
import { report } from './errors';
import { invariant } from '../src/errors';

export const create = action({
  args: { operationId: v.string(), name: v.string() },
  returns: v.id('hostedProjects'),
  handler: async (ctx, input): Promise<Id<'hostedProjects'>> => {
    try {
      const existing = await ctx.runQuery(internal.projectBootstrapStore.find, input);
      if (existing) return existing;
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to create a project.');
      const at = new Date().toISOString();
      const bootstrap = emptyHostedProject(input.operationId, at);
      const objects = [];
      for (const object of bootstrap.objects) {
        const nonce = randomUUID();
        const storageId = await blobStore(ctx).store(
          new Blob([object.text], {
            type: `application/x-forge-object-${nonce}`,
          }),
        );
        objects.push({ storageId: storageId as Id<'_storage'>, nonce });
      }
      // All project/source/Work pointers publish in one transaction. Unknown
      // outcomes retain these bytes; a retry reconciles the original operation.
      const result = await ctx.runMutation(internal.projectBootstrapStore.publish, { ...input, at, objects });
      if (!result.created) for (const object of objects) await blobStore(ctx).delete(object.storageId);
      return result.projectId;
    } catch (error) {
      return report(error);
    }
  },
});
