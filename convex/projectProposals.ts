// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { archivePut, reserveArchive, commitArchive, archiveTarget } from './archiveUpload';
import { isStored } from './projectObjectFields';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation, internalMutation, internalQuery } from './cliServer';
import { projectProposalDocument, projectBackupPreview } from './schema';
import { intentAuthority } from './projectContributors';
import { accessibleProject, activeProject } from './projectAuthority';
import { ownedProject } from './projectAuthority';
import {
  storageDigest,
  scanComplete,
  duplicatePage,
  removeDuplicate,
  removeExclusive,
} from './projectStorage';
import { invariant } from '../src/errors';
import { retainUploadCleanup, scheduleUploadSweep, retryRemovedUpload } from './projectLifecycle';
import { report } from './errors';

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
export const list = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(projectProposalDocument),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project proposals.');
      await accessibleProject(ctx, projectId, user.subject);
      return await ctx.db
        .query('projectProposals')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate(paginationOpts);
    } catch (error) {
      return report(error);
    }
  },
});
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
      const authority = await intentAuthority(ctx, input.projectId, input.actor, input.intentId),
        backup = await ctx.db.get(input.baseBackupId);
      invariant(
        authority.event?.baseBackupId === input.baseBackupId &&
          authority.command?.base === input.baseState &&
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
export const findUpload = internalQuery({
  args: { id: v.id('projectProposals'), actor: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ id: v.union(v.id('_storage'), v.null()), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, { id, actor, cursor }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(proposal?.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      await activeProject(ctx, proposal.projectId, actor);
      if (proposal.location === 'r2') return { id: null, isDone: true, cursor: '' };
      const page = await ctx.db.system.query('_storage').order('desc').paginate({ cursor, numItems: 100 });
      const file = page.page.find(
        file =>
          file.contentType === `application/x-forge-proposal-${proposal.nonce}` &&
          file.size === proposal.size &&
          storageDigest(file.sha256) === proposal.digest,
      );
      return {
        id: file?._id ?? null,
        isDone: scanComplete(page, proposal._creationTime),
        cursor: page.continueCursor,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = internalMutation({
  args: { id: v.id('projectProposals'), actor: v.string(), storageId: v.id('_storage') },
  returns: projectProposalDocument,
  handler: async (ctx, { id, actor, storageId }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(proposal?.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      await activeProject(ctx, proposal.projectId, actor);
      if (proposal.status === 'stored') {
        if (storageId !== proposal.storageId) await removeDuplicate(ctx, proposal, 'proposal', storageId);
        return proposal;
      }
      await intentAuthority(ctx, proposal.projectId, actor, proposal.intentId);
      const file = await ctx.db.system.get(storageId);
      invariant(
        file &&
          file.contentType === `application/x-forge-proposal-${proposal.nonce}` &&
          file.size === proposal.size &&
          storageDigest(file.sha256) === proposal.digest,
        'INVALID_WORK_BACKUP',
        'Uploaded bytes differ from this actor-bound proposal.',
      );
      await ctx.db.patch(id, { status: 'stored', storageId });
      return (await ctx.db.get(id))!;
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
      if (proposal.storageId) await removeExclusive(ctx, proposal.storageId, id);
      await ctx.db.delete(id);
      await scheduleUploadSweep(ctx, cleanup);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

export const validateUpload = internalQuery({
  args: { id: v.id('projectProposals'), actor: v.string(), storageId: v.id('_storage') },
  returns: v.null(),
  handler: async (ctx, { id, actor, storageId }) => {
    try {
      const proposal = await ctx.db.get(id);
      invariant(proposal?.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      await activeProject(ctx, proposal.projectId, actor);
      const file = await ctx.db.system.get(storageId);
      invariant(
        file &&
          file.contentType === `application/x-forge-proposal-${proposal.nonce}` &&
          file.size === proposal.size &&
          storageDigest(file.sha256) === proposal.digest,
        'INVALID_WORK_BACKUP',
        'Uploaded bytes differ from this actor-bound proposal.',
      );
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

export const reconcileDuplicates = internalMutation({
  args: { id: v.id('projectProposals'), actor: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { id, actor, cursor }) => {
    try {
      const row = await ctx.db.get(id);
      invariant(row && row.status === 'stored', 'PROJECT_UNAVAILABLE', 'Select this original stored upload.');
      invariant(row.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      await activeProject(ctx, row.projectId, actor);
      if (row.location === 'r2') return { cursor: '', isDone: true };
      return await duplicatePage(ctx, row, 'proposal', cursor);
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
      const root = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q =>
          q.eq('projectId', proposal.projectId).eq('digest', proposal.digest),
        )
        .unique();
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
