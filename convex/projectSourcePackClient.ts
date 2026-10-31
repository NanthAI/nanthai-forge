// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action, mutation } from './cliServer';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { latestSourcePack } from './projectSourcePackStore';
import { readableProject } from './projectObjectDownloads';
import { activeProject } from './projectAuthority';
import { hostedStartMain } from './projectHostedChannels';
import { reserveSourcePack, promoteSourcePack, sourcePackFlow } from './projectSourcePacks';
import { sourcePackUploadSchema } from '../src/source-pack';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Lane opens read the project's source pack with one call instead of one signing
 * page per 100 objects. A mutation so every URL is freshly signed; it writes nothing. */
export const latest = mutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.any(),
  handler: async (ctx, { projectId }) => {
    try {
      await readableProject(ctx, projectId);
      return await latestSourcePack(ctx, projectId);
    } catch (error) {
      return report(error);
    }
  },
});

type ClientInput = { projectId: Id<'hostedProjects'>; actor: string; object: string; cleanupAck?: string };
const clientArgs = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  object: v.string(),
  cleanupAck: v.optional(v.string()),
};
/** Contributors may publish a pack of the current hosted main only. Readers verify every
 * byte against a hash-verified State, so a pack can never supply different source. */
async function authorizedPack(ctx: MutationCtx, input: ClientInput) {
  await activeProject(ctx, input.projectId, input.actor);
  return sourcePackUploadSchema.parse(JSON.parse(input.object));
}
export const prepareClient = internalMutation({
  args: clientArgs,
  returns: v.any(),
  handler: async (ctx, input) => {
    const object = await authorizedPack(ctx, input);
    invariant(
      object.stateRef === (await hostedStartMain(ctx, input.projectId)).head,
      'WORK_STALE',
      'Pack the current hosted main.',
    );
    return reserveSourcePack(ctx, input.projectId, object, input.cleanupAck, Date.now());
  },
});
export const authorizeClient = internalMutation({
  args: clientArgs,
  returns: v.null(),
  handler: async (ctx, input) => {
    await authorizedPack(ctx, input);
    return null;
  },
});
export const commitClient = internalMutation({
  args: clientArgs,
  returns: v.null(),
  handler: async (ctx, input) => promoteSourcePack(ctx, input.projectId, await authorizedPack(ctx, input)),
});

/** prepare returns a signed PUT (or null when the pack is current or R2 is off);
 * commit verifies the upload with HEAD and makes it the project's latest pack. */
export const publish = action({
  args: {
    projectId: v.id('hostedProjects'),
    phase: v.union(v.literal('prepare'), v.literal('commit')),
    object: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, { projectId, phase, object }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to publish a source pack.');
      const parsed = sourcePackUploadSchema.parse(JSON.parse(object));
      const data = { projectId, actor: user.subject, object };
      const ref = (name: string) => makeFunctionReference<'mutation'>(`projectSourcePackClient:${name}`);
      return await sourcePackFlow(projectId, phase, parsed, {
        prepare: cleanupAck =>
          ctx.runMutation(ref('prepareClient'), cleanupAck ? { ...data, cleanupAck } : data),
        authorize: () => ctx.runMutation(ref('authorizeClient'), data),
        commit: () => ctx.runMutation(ref('commitClient'), data),
      });
    } catch (error) {
      return report(error);
    }
  },
});
