// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { proposalArgs } from './projectProposals';
import { projectProposalDocument } from './schema';
import { caller } from './projectWorkActions';
import { objectBytes } from './projectExchangeActions';
import { exchangeObjectReader } from './projectExchangeReader';
import { validateExchangePins } from './projectExchangeValidation';
import { resolveExchangeRoot } from '../src/native-exchange-tree';
import { sourceManifestSchema } from '../src/work-archive-metadata';
import { parseWorkBytes } from '../src/work-metadata';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export const publish = action({
  args: proposalArgs,
  returns: projectProposalDocument,
  handler: async (ctx, input): Promise<Doc<'projectProposals'>> => {
    try {
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) &&
          input.preview.format === 'native',
        'BAD_ARGUMENT',
        'Use an original proposal operation UUID and native source.',
      );
      const actor = await caller(ctx),
        reader = exchangeObjectReader(ctx);
      await ctx.runQuery(internal.projectObjects.authorize, { projectId: input.projectId, actor });
      const root = await objectBytes(
        ctx,
        input.projectId,
        actor,
        { sha256: input.digest, size: input.size },
        reader,
      );
      const resolved = await resolveExchangeRoot(root, pins => reader.read(input.projectId, actor, pins), {
        batchSize: 100,
      });
      const manifest = sourceManifestSchema.parse(JSON.parse(resolved.manifest.toString('utf8'))),
        data = parseWorkBytes(resolved.work);
      const view = data.views.find(item => item.id === input.viewId);
      invariant(
        manifest.kind === 'forge-native-work-backup' &&
          data.nativeHead === manifest.head &&
          data.revision === manifest.revision &&
          digest(resolved.manifest) === input.preview.manifestDigest &&
          manifest.revision === input.preview.revision &&
          manifest.head === input.preview.head &&
          view?.status === 'clean' &&
          view.head === input.head &&
          view.base === input.baseState &&
          view.intentId === input.intentId &&
          [input.head, input.baseState].every(head =>
            manifest.files.some(file => file.path === `objects/${head}` && file.sha256 === head),
          ) &&
          new Set(manifest.files.map(file => file.path)).size === manifest.files.length,
        'INVALID_WORK_BACKUP',
        'Proposal metadata must contain the selected clean native View and original Intent base.',
      );
      await validateExchangePins(
        ctx,
        input.projectId,
        actor,
        manifest.files.filter(file => file.path !== 'work.json'),
      );
      const id: Id<'projectProposals'> = await ctx.runMutation(internal.projectProposals.register, {
        ...input,
        actor,
        transport: 'objects',
        request: digest(JSON.stringify(canonical(['objects', actor, input]))),
        nonce: crypto.randomUUID(),
      });
      return await ctx.runMutation(internal.projectProposals.completeObjects, { id, actor });
    } catch (error) {
      return report(error);
    }
  },
});
export const checkpoint = action({
  args: { proposalId: v.id('projectProposals') },
  returns: v.object({ json: v.string(), digest: v.string(), size: v.number(), sourceDigest: v.string() }),
  handler: async (
    ctx,
    { proposalId },
  ): Promise<{ json: string; digest: string; size: number; sourceDigest: string }> => {
    try {
      const actor = await caller(ctx),
        proposal: Doc<'projectProposals'> = await ctx.runQuery(internal.projectProposals.get, {
          id: proposalId,
          actor,
        });
      invariant(
        proposal.status === 'stored' && proposal.transport === 'objects',
        'SOURCE_UNAVAILABLE',
        'Select a stored object proposal.',
      );
      const bytes = await objectBytes(ctx, proposal.projectId, actor, {
        sha256: proposal.digest,
        size: proposal.size,
      });
      await ctx.runQuery(internal.projectProposals.get, { id: proposalId, actor });
      return {
        json: bytes.toString('utf8'),
        digest: proposal.digest,
        size: proposal.size,
        sourceDigest: proposal.digest,
      };
    } catch (error) {
      return report(error);
    }
  },
});

export const details = action({
  args: { proposalId: v.id('projectProposals') },
  returns: v.object({ projectKey: v.string(), proposal: projectProposalDocument }),
  handler: async (
    ctx,
    { proposalId },
  ): Promise<{ projectKey: string; proposal: Doc<'projectProposals'> }> => {
    try {
      const actor = await caller(ctx),
        proposal = await ctx.runQuery(internal.projectProposals.get, { id: proposalId, actor });
      invariant(
        proposal.transport === 'objects' && proposal.status === 'stored',
        'SOURCE_UNAVAILABLE',
        'Select a stored object proposal.',
      );
      const { project } = await ctx.runQuery(internal.projectBackups.get, {
        id: proposal.baseBackupId,
        owner: actor,
      });
      return { projectKey: project.key, proposal };
    } catch (error) {
      return report(error);
    }
  },
});
