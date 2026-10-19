// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { projectProposalDocument } from './schema';
import { proposalArgs } from './projectProposals';
import { caller } from './projectWorkActions';
import { sourceManifestSchema } from '../src/work-archive-metadata';
import { parseWorkBytes } from '../src/work-metadata';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';
import { projectArchivePart } from './projectArchivePart';
import { projectArchiveMetadata } from './projectArchiveMetadata';
async function checkedComplete(
  ctx: ActionCtx,
  id: Id<'projectProposals'>,
  actor: string,
  storageId: Id<'_storage'>,
): Promise<Doc<'projectProposals'>> {
  const proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
  invariant(proposal.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
  if (proposal.status === 'stored')
    return await ctx.runMutation(internal.projectProposals.complete, { id, actor, storageId });
  await ctx.runQuery(internal.projectProposals.validateUpload, { id, actor, storageId });
  const bytes = await projectArchiveMetadata(ctx, storageId, proposal.size, proposal.digest, () =>
      ctx.runQuery(internal.projectProposals.get, { id, actor }),
    ),
    manifest = sourceManifestSchema.parse(JSON.parse(Buffer.from(bytes.manifest).toString('utf8'))),
    data = parseWorkBytes(bytes.work);
  const work = manifest.files.find(file => file.path === 'work.json'),
    view = data.views.find(item => item.id === proposal.viewId);
  invariant(
    manifest.kind === 'forge-native-work-backup' &&
      Boolean(data.nativeHead) &&
      digest(bytes.manifest) === proposal.preview.manifestDigest &&
      digest(bytes.work) === work?.sha256 &&
      bytes.work.byteLength === work.size &&
      data.revision === manifest.revision &&
      manifest.revision === proposal.preview.revision &&
      manifest.head === proposal.preview.head &&
      view?.status === 'clean' &&
      view.head === proposal.head &&
      view.base === proposal.baseState &&
      view.intentId === proposal.intentId &&
      [proposal.head, proposal.baseState].every(head =>
        manifest.files.some(file => file.path === `objects/${head}` && file.sha256 === head),
      ),
    'INVALID_WORK_BACKUP',
    'Proposal metadata does not contain the selected clean native View, head and original Intent base.',
  );
  // The atomic final mutation rechecks current grant and server-created Intent after these asynchronous reads.
  return await ctx.runMutation(internal.projectProposals.complete, { id, actor, storageId });
}
async function reconcile(
  ctx: ActionCtx,
  id: Id<'projectProposals'>,
  actor: string,
  cleanupStored = false,
): Promise<Doc<'projectProposals'>> {
  const proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
  invariant(proposal.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
  if (proposal.status === 'stored') {
    if (!cleanupStored) return proposal;
    let cleanupCursor: string | null = null;
    while (true) {
      const observed: { cursor: string; isDone: boolean } = await ctx.runMutation(
        internal.projectProposals.reconcileDuplicates,
        { id, actor, cursor: cleanupCursor },
      );
      if (observed.isDone) break;
      cleanupCursor = observed.cursor;
    }
    return proposal;
  }
  let cursor: string | null = null;
  while (true) {
    const page: { id: Id<'_storage'> | null; isDone: boolean; cursor: string } = await ctx.runQuery(
      internal.projectProposals.findUpload,
      { id, actor, cursor },
    );
    if (page.id) return await checkedComplete(ctx, id, actor, page.id);
    if (page.isDone) return proposal;
    cursor = page.cursor;
  }
}
export const prepare = action({
  args: proposalArgs,
  returns: v.object({
    proposal: projectProposalDocument,
    uploadUrl: v.optional(v.string()),
    contentType: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    input,
  ): Promise<{ proposal: Doc<'projectProposals'>; uploadUrl?: string; contentType?: string }> => {
    try {
      const actor = await caller(ctx),
        uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
        sha = /^[0-9a-f]{64}$/;
      invariant(
        [input.operationId, input.intentId, input.viewId].every(value => uuid.test(value)) &&
          [
            input.baseArchiveSha256,
            input.baseState,
            input.head,
            input.digest,
            input.preview.manifestDigest,
            input.preview.head,
          ].every(value => sha.test(value)) &&
          Number.isSafeInteger(input.size) &&
          input.size > 0 &&
          input.preview.format === 'native',
        'BAD_ARGUMENT',
        'Select exact native proposal archive, Intent, View and source pins.',
      );
      const p = input.preview;
      invariant(
        [p.revision, p.intents, p.lanes, p.views, p.runs, p.files, p.unavailable].every(
          value => Number.isSafeInteger(value) && value >= 0,
        ) && p.channels.every(pin => pin.name && sha.test(pin.head)),
        'BAD_ARGUMENT',
        'Select a valid native archive preview.',
      );
      const request = digest(
        JSON.stringify([
          input.projectId,
          actor,
          input.operationId,
          input.intentId,
          input.baseBackupId,
          input.baseArchiveSha256,
          input.baseState,
          input.head,
          input.viewId,
          input.digest,
          input.size,
          p.manifestDigest,
          p.head,
          p.format,
          p.revision,
          p.intents,
          p.lanes,
          p.views,
          p.runs,
          p.files,
          p.unavailable,
          p.channels.map(pin => [pin.name, pin.head]),
        ]),
      );
      const id: Id<'projectProposals'> = await ctx.runMutation(internal.projectProposals.register, {
        ...input,
        actor,
        request,
        nonce: randomUUID(),
      });
      const proposal = await reconcile(ctx, id, actor);
      if (proposal.status === 'stored') return { proposal };
      return {
        proposal,
        uploadUrl: await ctx.runMutation(internal.projectProposals.uploadUrl, { id, actor }),
        contentType: `application/x-forge-proposal-${proposal.nonce}`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = action({
  args: { id: v.id('projectProposals'), storageId: v.id('_storage') },
  returns: projectProposalDocument,
  handler: async (ctx, { id, storageId }): Promise<Doc<'projectProposals'>> => {
    try {
      return await checkedComplete(ctx, id, await caller(ctx), storageId);
    } catch (error) {
      try {
        await ctx.runMutation(internal.projectLifecycle.cleanupUpload, {
          uploadId: id,
          actor: await caller(ctx),
          storageId,
        });
      } catch {
        /* Foreign/unattributable files remain untouched. */
      }
      return report(error);
    }
  },
});
export const reconcileUpload = action({
  args: { id: v.id('projectProposals') },
  returns: projectProposalDocument,
  handler: async (ctx, { id }): Promise<Doc<'projectProposals'>> => {
    try {
      return await reconcile(ctx, id, await caller(ctx), true);
    } catch (error) {
      return report(error);
    }
  },
});
export const downloadPart = action({
  args: { id: v.id('projectProposals'), offset: v.number(), digest: v.string() },
  returns: v.object({ data: v.bytes(), size: v.number(), digest: v.string(), filename: v.string() }),
  handler: async (
    ctx,
    { id, offset, digest: expected },
  ): Promise<{ data: ArrayBuffer; size: number; digest: string; filename: string }> => {
    try {
      const actor = await caller(ctx),
        proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
      invariant(
        proposal.status === 'stored' && proposal.storageId && expected === proposal.digest,
        'PROJECT_CHANGED',
        'Select the original stored proposal and digest.',
      );
      invariant(
        Number.isSafeInteger(offset) && offset >= 0 && offset < proposal.size,
        'BAD_ARGUMENT',
        'Invalid proposal archive offset.',
      );
      const data = await projectArchivePart(
        ctx,
        proposal.storageId,
        proposal.size,
        proposal.digest,
        offset,
        () => ctx.runQuery(internal.projectProposals.get, { id, actor }),
      );
      await ctx.runQuery(internal.projectProposals.get, { id, actor });
      return {
        data,
        size: proposal.size,
        digest: proposal.digest,
        filename: `forge-proposal-${proposal.operationId}.tar.gz`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
