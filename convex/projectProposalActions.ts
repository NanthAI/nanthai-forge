// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { presignGet, r2Config } from './r2';
import { workArchiveMetadata } from '../src/work-archive-metadata';
import { exchangeRequest } from '../src/exchange-request';

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
): Promise<Doc<'projectProposals'>> {
  const proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
  invariant(proposal.actor === actor, 'PROJECT_UNAVAILABLE', 'This upload belongs to another actor.');
  if (proposal.transport === 'objects' || proposal.location !== 'r2' || proposal.status === 'stored')
    return proposal;
  if (await verifyArchiveUpload(proposal)) {
    await validateR2Proposal(ctx, proposal, actor);
    return ctx.runMutation(internal.projectProposals.completeR2, { id, actor, key: proposal.r2Key! });
  }
  return proposal;
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
  args: { id: v.id('projectProposals') },
  returns: projectProposalDocument,
  handler: async (ctx, { id }): Promise<Doc<'projectProposals'>> => {
    try {
      const actor = await caller(ctx),
        proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, { id, actor });
      invariant(proposal.location === 'r2', 'R2_REQUIRED', 'Proposals upload to R2 only.');
      invariant(await verifyArchiveUpload(proposal), 'R2_OBJECT_MISSING', 'Uploaded archive is missing.');
      await validateR2Proposal(ctx, proposal, actor);
      return await ctx.runMutation(internal.projectProposals.completeR2, {
        id,
        actor,
        key: proposal.r2Key!,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const reconcileUpload = action({
  args: { id: v.id('projectProposals') },
  returns: projectProposalDocument,
  handler: async (ctx, { id }): Promise<Doc<'projectProposals'>> => {
    try {
      return await reconcile(ctx, id, await caller(ctx));
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
          proposal.location === 'r2' &&
          proposal.r2Committed &&
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
      invariant(direct, 'R2_OBJECT_UNAVAILABLE', 'The stored proposal is unavailable.');
      const data = direct.data;
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
