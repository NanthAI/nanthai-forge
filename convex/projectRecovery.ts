// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { serverRecoveryAuthority } from '../src/recovery-authority';
import { query, mutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id, Doc } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { sourceAuthority } from '../src/hosted-source-authority';
import {
  recoverySelectionSchema,
  recoveryConnectionSchema,
  sameRecoveryPins,
} from '../src/recovery-protocol';
import { hostedProjectRoot } from '../src/project-routes';
import { hostedStartMain } from './projectHostedChannels';
import { accountFor } from './urlIdentity';
import { invariant } from '../src/errors';
import { report } from './errors';

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
  return recoverySelectionSchema.parse({
    projectId: project._id,
    ownerId: project.key,
    backupId: backup._id,
    checkpointSha256: backup.digest,
    checkpointSize: backup.size,
    manifestSha256: backup.preview.manifestDigest,
    revision: project.work!.revision,
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
  args: scope,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await recoveryOwned(ctx, input.projectId),
        old = serverRecoveryAuthority({ binding: project })
          ? null
          : await find(ctx, input.projectId, input.operationId);
      return JSON.stringify(
        old
          ? {
              authority: sourceAuthority(project),
              selection: null,
              receipt: recoveryConnectionSchema.parse(JSON.parse(old.receipt)),
            }
          : {
              authority: sourceAuthority(project),
              selection: await recoverySelection(ctx, project),
              receipt: null,
            },
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** Records an explicit reconnect, without changing project identity, source, authority or access. */
export const reconnect = mutation({
  args: {
    ...scope,
    selection: v.string(),
    requestHash: v.string(),
    role: v.union(v.literal('owner'), v.literal('client')),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await recoveryOwned(ctx, input.projectId),
        expected = recoverySelectionSchema.parse(JSON.parse(input.selection)),
        request = JSON.stringify({ selection: expected, requestHash: input.requestHash, role: input.role }),
        old = await find(ctx, input.projectId, input.operationId);
      invariant(
        !serverRecoveryAuthority({ binding: project }),
        'SOURCE_AUTHORITY_STALE',
        'Server-authority projects recover a runner and cache, never a native accepting owner.',
      );
      if (old) {
        invariant(
          old.request === request,
          'WORK_OPERATION_CHANGED',
          'Replay the original recovery operation and pins.',
        );
        return old.receipt;
      }
      const current = await recoverySelection(ctx, project);
      invariant(
        sameRecoveryPins(current, expected),
        'WORK_STALE',
        'Hosted source, Work or authority changed during recovery. The recovered files remain private and preserved.',
      );
      const web = process.env.FORGE_WEB_URL ?? process.env.SITE_URL,
        account = await accountFor(ctx, project.owner);
      invariant(
        web && account && project.slug,
        'HOST_CONFIGURATION',
        'Configure the existing hosted project URL.',
      );
      const url = new URL(web);
      url.pathname = hostedProjectRoot(account.handle, project.slug);
      url.search = '';
      url.hash = '';
      const receipt = JSON.stringify(
        recoveryConnectionSchema.parse({
          operationId: input.operationId,
          requestHash: input.requestHash,
          role: input.role,
          selection: current,
          binding: {
            projectId: project._id,
            operationId: project.key,
            projectUrl: url.href,
            name: project.name,
            visibility: project.visibility ?? 'private',
            backupId: current.backupId,
          },
        }),
      );
      await ctx.db.insert('projectRecoveryConnections', {
        projectId: input.projectId,
        operationId: input.operationId,
        request,
        receipt,
      });
      return receipt;
    } catch (error) {
      return report(error);
    }
  },
});
