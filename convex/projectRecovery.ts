// SPDX-License-Identifier: Apache-2.0
import { v, ConvexError } from 'convex/values';
import { CUTOVER_UPGRADE } from '../src/cutover-version';
import { serverRecoveryAuthority } from '../src/recovery-authority';
import { query, mutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id, Doc } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { sourceAuthority } from '../src/hosted-source-authority';
import { recoverySelectionSchema, recoveryConnectionSchema } from '../src/recovery-protocol';
import { hostedStartMain } from './projectHostedChannels';
import { invariant } from '../src/errors';
import { report } from './errors';
import { capsuleRecoveryRevision } from './projectLandingCapsuleRecovery';

const scope = { projectId: v.id('hostedProjects'), operationId: v.string() };
export async function recoveryOwned(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to recover this existing project.');
  return activeOwnedProject(ctx, projectId, user.subject);
}
export async function recoverySelection(ctx: QueryCtx | MutationCtx, original: Doc<'hostedProjects'>) {
  const project = await workProject(ctx, original),
    backup = project.work ? await ctx.db.get(project.work.backupId) : null;
  invariant(
    backup?.projectId === project._id && backup.status === 'stored' && backup.preview.format === 'native',
    'SOURCE_UNAVAILABLE',
    'Select an existing native project with a stored source/Work checkpoint.',
  );
  const authority = sourceAuthority(project);
  const hostedMain = authority.mode === 'server' ? await hostedStartMain(ctx, project._id) : undefined;
  invariant(
    !hostedMain ||
      (hostedMain.authority.mode === authority.mode && hostedMain.authority.epoch === authority.epoch),
    'SOURCE_AUTHORITY_CHANGED',
    'Hosted recovery main and project authority differ.',
  );
  const capsuleRevision = await capsuleRecoveryRevision(ctx, project._id);
  return recoverySelectionSchema.parse({
    projectId: project._id,
    ownerId: project.key,
    backupId: backup._id,
    checkpointSha256: backup.digest,
    checkpointSize: backup.size,
    manifestSha256: backup.preview.manifestDigest,
    revision: project.work!.revision,
    ...(capsuleRevision ? { capsuleRevision } : {}),
    ...(project.journalRevision ? { journalRevision: project.journalRevision } : {}),
    authority,
    ...(hostedMain ? { hostedMain } : {}),
    transport: backup.transport ?? 'archive',
    completeHistory: backup.historyBackfilling
      ? 'incomplete'
      : backup.validatedClosure
        ? 'complete'
        : 'unknown',
  });
}
const find = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('projectRecoveryConnections')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();

/** Current account authority is checked even when reconciling a saved connection. */
export const prepare = query({
  args: { ...scope, capsuleProtocol: v.optional(v.literal(1)) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await recoveryOwned(ctx, input.projectId),
        old = serverRecoveryAuthority({ binding: project })
          ? null
          : await find(ctx, input.projectId, input.operationId);
      const selection = old ? null : await recoverySelection(ctx, project);
      invariant(
        (!selection?.capsuleRevision && !selection?.journalRevision) || input.capsuleProtocol === 1,
        'CLI_UPGRADE_REQUIRED',
        'This recovery includes landing capsules. Run nforge update and retry.',
      );
      return JSON.stringify(
        old
          ? {
              authority: sourceAuthority(project),
              selection: null,
              receipt: recoveryConnectionSchema.parse(JSON.parse(old.receipt)),
            }
          : {
              authority: sourceAuthority(project),
              selection,
              receipt: null,
            },
      );
    } catch (error) {
      return report(error);
    }
  },
});

// Retain the old address for installed clients; native owner/client reconnect is removed.
export const reconnect = mutation({
  args: {
    ...scope,
    selection: v.string(),
    requestHash: v.string(),
    role: v.union(v.literal('owner'), v.literal('client')),
  },
  returns: v.string(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
