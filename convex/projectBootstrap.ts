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
import { storeSourceBytes } from './projectSourceBytes';

export const create = action({
  args: { operationId: v.string(), name: v.string() },
  returns: v.id('hostedProjects'),
  handler: async (ctx, input): Promise<Id<'hostedProjects'>> => {
    try {
      const existing = await ctx.runQuery(internal.projectBootstrapStore.find, input);
      if (existing) return existing;
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to create a project.');
      const prepared = await ctx.runMutation(internal.projectBootstrapStore.prepare, input);
      const at = prepared.at;
      const bootstrap = emptyHostedProject(input.operationId, at);
      const projectId = prepared.projectId;
      const objects = [];
      for (const object of bootstrap.objects) {
        const nonce = randomUUID();
        const stored = await storeSourceBytes(
          ctx,
          projectId,
          new TextEncoder().encode(object.text),
          object,
          true,
        );
        objects.push({ ...stored, nonce });
      }
      // All project/source/Work pointers publish in one transaction. Unknown
      // outcomes retain these bytes; a retry reconciles the original operation.
      const result = await ctx.runMutation(internal.projectBootstrapStore.publish, {
        ...input,
        at,
        objects,
        ...(projectId ? { projectId } : {}),
      });
      if (!result.created)
        for (const object of objects)
          if ('storageId' in object) await blobStore(ctx).delete(object.storageId);
      return result.projectId;
    } catch (error) {
      return report(error);
    }
  },
});
