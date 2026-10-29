// SPDX-License-Identifier: Apache-2.0
'use node';
import { archivePut, verifyArchiveUpload } from './archiveUpload';
import type { R2PutTarget } from './r2';
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
import { archiveDownload, directDownloadFields, type DirectDownload } from './archiveDownload';
import { projectArchivePart } from './projectArchivePart';
import { presignGet, r2Config } from './r2';
import { workArchiveMetadata } from '../src/work-archive-metadata';
import { exchangeRequest } from '../src/exchange-request';
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
  const r2: boolean = await ctx.runQuery(internal.projectExchangeCache.placement, {
    projectId: proposal.projectId,
    actor,
  });
  const bytes = await projectArchiveMetadata(
    ctx,
    storageId,
    proposal.size,
    proposal.digest,
    () => ctx.runQuery(internal.projectProposals.get, { id, actor }),
    true,
    r2,
  );
  validateProposalMetadata(proposal, bytes);
  // The atomic final mutation rechecks current grant and server-created Intent after these asynchronous reads.
  return await ctx.runMutation(internal.projectProposals.complete, { id, actor, storageId });
}
function validateProposalMetadata(
  proposal: Doc<'projectProposals'>,
  bytes: { manifest: Uint8Array; work: Uint8Array },
) {
  const manifest = sourceManifestSchema.parse(JSON.parse(Buffer.from(bytes.manifest).toString('utf8'))),
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
}
async function validateR2Proposal(ctx: ActionCtx, proposal: Doc<'projectProposals'>, actor: string) {
  const bytes = await exchangeRequest(
    'R2 proposal metadata',
    await presignGet(r2Config(), proposal.r2Key!),
    { headers: { 'accept-encoding': 'identity' } },
    async (response, progressed) => {
      invariant(response.ok && response.body, 'INVALID_WORK_BACKUP', 'Stored proposal is unavailable.');
      try {
        return await workArchiveMetadata(response.body, undefined, progressed);
      } finally {
        if (response.body && !response.body.locked) await response.body.cancel();
      }
    },
  );
  validateProposalMetadata(proposal, bytes);
  await ctx.runQuery(internal.projectProposals.get, { id: proposal._id, actor });
}
async function reconcile(
  ctx: ActionCtx,
  id: Id<'projectProposals'>,
  actor: string,
  cleanupStored = false,
): Promise<Doc<'projectProposals'>> {
  const proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
  invariant(proposal.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
  if (proposal.transport === 'objects') return proposal;
  if (proposal.location === 'r2') {
    if (proposal.status === 'stored') return proposal;
    if (await verifyArchiveUpload(proposal)) {
      await validateR2Proposal(ctx, proposal, actor);
      return ctx.runMutation(internal.projectProposals.completeR2, { id, actor, key: proposal.r2Key! });
    }
    return proposal;
  }
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
    target: v.optional(archivePut),
    contentType: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    input,
  ): Promise<{
    proposal: Doc<'projectProposals'>;
    uploadUrl?: string;
    target?: R2PutTarget;
    contentType?: string;
  }> => {
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
      const proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, {
        id,
        actor,
      });
      invariant(proposal.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
      if (proposal.status === 'stored') return { proposal };
      const target = await ctx.runMutation(internal.projectProposals.uploadUrl, { id, actor });
      return {
        proposal,
        ...(typeof target === 'string' ? { uploadUrl: target } : { target }),
        contentType: `application/x-forge-proposal-${proposal.nonce}`,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = action({
  args: { id: v.id('projectProposals'), storageId: v.optional(v.id('_storage')) },
  returns: projectProposalDocument,
  handler: async (ctx, { id, storageId }): Promise<Doc<'projectProposals'>> => {
    try {
      const actor = await caller(ctx),
        proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
      if (proposal.location === 'r2') {
        invariant(await verifyArchiveUpload(proposal), 'R2_OBJECT_MISSING', 'Uploaded archive is missing.');
        await validateR2Proposal(ctx, proposal, actor);
        return await ctx.runMutation(internal.projectProposals.completeR2, {
          id,
          actor,
          key: proposal.r2Key!,
        });
      }
      invariant(storageId, 'INVALID_WORK_BACKUP', 'Select the original legacy upload.');
      return await checkedComplete(ctx, id, await caller(ctx), storageId);
    } catch (error) {
      try {
        if (storageId)
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
  returns: v.object({
    ...directDownloadFields,
    data: v.bytes(),
    size: v.number(),
    digest: v.string(),
    filename: v.string(),
  }),
  handler: async (
    ctx,
    { id, offset, digest: expected },
  ): Promise<DirectDownload & { size: number; digest: string; filename: string }> => {
    try {
      const actor = await caller(ctx),
        proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
      invariant(
        proposal.status === 'stored' &&
          (proposal.storageId || (proposal.location === 'r2' && proposal.r2Committed)) &&
          expected === proposal.digest,
        'PROJECT_CHANGED',
        'Select the original stored proposal and digest.',
      );
      invariant(
        Number.isSafeInteger(offset) && offset >= 0 && offset < proposal.size,
        'BAD_ARGUMENT',
        'Invalid proposal archive offset.',
      );
      const direct = await archiveDownload(ctx, proposal);
      const data = direct
        ? direct.data
        : await projectArchivePart(ctx, proposal.storageId!, proposal.size, proposal.digest, offset, () =>
            ctx.runQuery(internal.projectProposals.get, { id, actor }),
          );
      await ctx.runQuery(internal.projectProposals.get, { id, actor });
      return {
        ...direct,
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
