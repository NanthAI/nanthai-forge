// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { archivePut, reserveArchive, commitArchive, archiveTarget } from './archiveUpload';
import { isStored } from './projectObjectFields';

import { mutation, internalMutation, internalQuery } from './cliServer';
import { projectProposalDocument, projectBackupPreview } from './schema';
import { intentAuthority } from './projectContributors';
import { accessibleProject, activeProject } from './projectAuthority';
import { ownedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { retainUploadCleanup, scheduleUploadSweep, retryRemovedUpload } from './projectLifecycle';
import { report } from './errors';
import { assertAccountActive } from './accountLimits';
import { findObject } from './projectObjectFind';
import { findWorkEvent } from './projectWorkEventStore';

export const proposalArgs = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  intentId: v.string(),
  baseBackupId: v.id('projectBackups'),
  baseArchiveSha256: v.string(),
  baseState: v.string(),
  head: v.string(),
  viewId: v.string(),
  digest: v.string(),
  size: v.number(),
  preview: projectBackupPreview,
};

export const get = internalQuery({
  args: { id: v.id('projectProposals'), actor: v.string() },
  returns: projectProposalDocument,
  handler: async (ctx, { id, actor }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(proposal, 'PROJECT_UNAVAILABLE', 'This proposal is unavailable.');
      await accessibleProject(ctx, proposal.projectId, actor);
      return proposal;
    } catch (error) {
      return report(error);
    }
  },
});
export const register = internalMutation({
  args: {
    ...proposalArgs,
    transport: v.optional(v.literal('objects')),
    actor: v.string(),
    request: v.string(),
    nonce: v.string(),
  },
  returns: v.id('projectProposals'),
  handler: async (ctx, input) => {
    try {
      await activeProject(ctx, input.projectId, input.actor);
      const old = await ctx.db
        .query('projectProposals')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.actor === input.actor && old.request === input.request,
          'WORK_OPERATION_CHANGED',
          'Reconcile this proposal’s original actor and pins.',
        );
        return old._id;
      }
      await assertAccountActive(ctx, input.actor);
      const authority = await intentAuthority(ctx, input.projectId, input.actor, input.intentId),
        backup = await ctx.db.get(input.baseBackupId);
      // A record-store Intent keeps its creation in its retained version, not a journal event (Item c0af6cfa).
      const event =
        authority.event ??
        (await findWorkEvent(ctx, input.projectId, authority.targetId, { authority: true }));
      const command = event ? (JSON.parse(event.command) as { action?: string; base?: string }) : null;
      invariant(
        event?.baseBackupId === input.baseBackupId &&
          command?.action === 'intent' &&
          command.base === input.baseState &&
          backup?.projectId === input.projectId &&
          backup.status === 'stored' &&
          backup.preview.format === 'native' &&
          backup.digest === input.baseArchiveSha256,
        'SOURCE_UNAVAILABLE',
        'Select this Intent’s original server-pinned native source archive and State.',
      );
      invariant(
        input.transport === 'objects',
        'ARCHIVE_TRANSPORT_RETIRED',
        'New proposals use object exchange. Existing archive uploads remain resumable.',
      );
      return await ctx.db.insert('projectProposals', { ...input, status: 'uploading' });
    } catch (error) {
      return report(error);
    }
  },
});
export const uploadUrl = internalMutation({
  args: { id: v.id('projectProposals'), actor: v.string() },
  returns: v.union(v.string(), archivePut),
  handler: async (ctx, { id, actor }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(proposal?.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      await activeProject(ctx, proposal.projectId, actor);
      invariant(proposal.status === 'uploading', 'PROJECT_CHANGED', 'This proposal is already stored.');
      const { r2Key } = await reserveArchive(ctx, proposal);
      const target = await archiveTarget({ ...proposal, r2Key });
      await ctx.db.patch(id, { location: 'r2', r2Key });
      return target;
    } catch (error) {
      return report(error);
    }
  },
});
// Explicit owner cleanup covers recorded stored proposal objects only, never arbitrary IDs.
export const remove = mutation({
  args: { id: v.id('projectProposals') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        proposal = await ctx.db.get(id);
      invariant(user, 'PROJECT_UNAVAILABLE', 'This proposal is unavailable.');
      if (!proposal) {
        await retryRemovedUpload(ctx, id, user.subject);
        return null;
      }
      const project = await ownedProject(ctx, proposal.projectId, user.subject);
      const cleanup = await retainUploadCleanup(ctx, project, proposal, 'proposal');
      await ctx.db.delete(id);
      await scheduleUploadSweep(ctx, cleanup);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

export const completeObjects = internalMutation({
  args: { id: v.id('projectProposals'), actor: v.string() },
  returns: projectProposalDocument,
  handler: async (ctx, { id, actor }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(
        proposal?.actor === actor && proposal.transport === 'objects',
        'PROJECT_UNAVAILABLE',
        'Select this actor’s object proposal.',
      );
      await intentAuthority(ctx, proposal.projectId, actor, proposal.intentId);
      const root = await findObject(ctx, proposal.projectId, proposal.digest);
      invariant(
        root && !root.removed && isStored(root) && root.size === proposal.size,
        'INVALID_WORK_BACKUP',
        'Proposal root is unavailable.',
      );
      await ctx.db.patch(id, { status: 'stored' });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});

/** Only the owning action calls this after HEAD verification of this exact key. */
export const completeR2 = internalMutation({
  args: { id: v.id('projectProposals'), actor: v.string(), key: v.string() },
  returns: projectProposalDocument,
  handler: async (ctx, { id, actor, key }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(
        proposal && proposal.location === 'r2' && proposal.r2Key === key,
        'INVALID_WORK_BACKUP',
        'Original archive reservation changed.',
      );
      invariant(proposal.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      await activeProject(ctx, proposal.projectId, actor);
      await intentAuthority(ctx, proposal.projectId, actor, proposal.intentId);
      await commitArchive(ctx, proposal);
      if (proposal.status !== 'stored') await ctx.db.patch(id, { status: 'stored', r2Committed: true });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});
