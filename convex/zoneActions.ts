// SPDX-License-Identifier: Apache-2.0
'use node';
import { v, ConvexError, type Infer } from 'convex/values';
import { blobStore } from './blobStore';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { zoneChange, zoneUpdate } from './schema';
import { currentAccess, githubConfig } from './access';
import { checkForgeUser } from './sharingActions';
import { authorizeGithub } from '../src/github-access';
import { githubJson } from '../src/github';
import { decodeHostedArtifact, encodeHostedArtifact } from '../src/hosted-artifact';
import { agentProjection } from '../src/agent-query';
import { derivedArtifact, derivedBytes } from './derivedArtifactActions';
import { archiveDownload, directDownloadFields } from './archiveDownload';
import { projectArchivePart } from './projectArchivePart';
import { hostedStatus, type HostedStatus } from '../src/hosted-status';
import { hostedQuery } from '../src/hosted-query';
import { identity } from '../src/hash';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';

const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
async function actor(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'ZONE_UNAVAILABLE', 'Sign in to use private source Zones.');
  return user.subject;
}
async function access(ctx: ActionCtx, id: Id<'sourceZones'>, reader: string) {
  const zone: Doc<'sourceZones'> = await ctx.runQuery(internal.sourceZones.authorize, { id, actor: reader });
  const source = await currentAccess(ctx, zone.importId, zone.owner, false, true);
  if (reader !== zone.owner) await authorizeGithub(source.job.repository, reader, githubConfig());
  await ctx.runQuery(internal.sourceZones.authorize, { id, actor: reader });
  return { zone, ...source };
}
async function projectSource(
  ctx: ActionCtx,
  id: Id<'sourceZones'>,
  source: Awaited<ReturnType<typeof access>>,
) {
  const blob = await blobStore(ctx).get(source.zone.artifactKey);
  invariant(blob, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
  const artifact = await decodeHostedArtifact(blob);
  invariant(
    artifact.pack.source.id === source.zone.sourceId && artifact.pack.source.gitHead === source.zone.gitHead,
    'ARTIFACT_INTEGRITY',
    'Stored source differs from the Zone snapshot.',
  );
  // Reuse selected-only graph/source identities and count/traversal projection; do not rewrite authoritative source mentions.
  const scoped = {
    ...agentProjection(artifact, source.zone.files),
    projection: {
      kind: 'forge-source-zone',
      id,
      name: source.zone.name,
      creator: source.zone.owner,
      originalSourceId: source.zone.sourceId,
      originalAnalysisId: artifact.pack.id,
      gitHead: source.zone.gitHead,
      coverage:
        'Selected retained source files only. Repository documents, global counts and relationships outside these files are not included; delivered copies cannot be recalled.',
    },
  };
  return { ...source, scoped };
}
function projectionPin(zone: Doc<'sourceZones'>) {
  return identity({
    id: zone._id,
    name: zone.name,
    creator: zone.owner,
    sourceId: zone.sourceId,
    gitHead: zone.gitHead,
    files: zone.files,
  });
}
async function zoneExport(ctx: ActionCtx, id: Id<'sourceZones'>, reader: string) {
  const source = await access(ctx, id, reader);
  const record = await derivedArtifact(
    ctx,
    source.zone.artifactKey,
    'zone-export-v1',
    projectionPin(source.zone),
    async () => {
      const { scoped } = await projectSource(ctx, id, source);
      return encodeHostedArtifact(scoped);
    },
    () => access(ctx, id, reader),
  );
  invariant(record?.storageId, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
  return { ...source, record };
}
export const create = action({
  args: {
    importId: v.id('imports'),
    operationId: v.string(),
    name: v.string(),
    sourceId: v.string(),
    files: v.array(v.string()),
  },
  returns: v.id('sourceZones'),
  handler: async (ctx, input): Promise<Id<'sourceZones'>> => {
    try {
      const owner = await actor(ctx),
        files = [...new Set(input.files)].sort(),
        name = input.name.trim();
      invariant(
        uuid(input.operationId) && name && /^[a-f0-9]{64}$/.test(input.sourceId) && files.length,
        'BAD_ARGUMENT',
        'Choose a name, original snapshot, operation UUID and included files.',
      );
      const request = identity({ importId: input.importId, name, sourceId: input.sourceId, files });
      const old: Doc<'sourceZones'> | null = await ctx.runQuery(internal.sourceZones.created, {
        owner,
        operationId: input.operationId,
      });
      if (old) {
        invariant(
          old.request === request,
          'ZONE_OPERATION_CHANGED',
          'Reconcile the original source Zone request.',
        );
        return old._id;
      }
      const { job } = await currentAccess(ctx, input.importId, owner, false, true);
      invariant(
        job.owner === owner && job.visibility === 'private' && job.artifactKey,
        'ZONE_UNAVAILABLE',
        'Choose your own indexed private import.',
      );
      const blob = await blobStore(ctx).get(job.artifactKey as Id<'_storage'>);
      invariant(blob, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      const artifact = await decodeHostedArtifact(blob);
      invariant(
        artifact.pack.source.id === input.sourceId,
        'ZONE_SOURCE_CHANGED',
        'The import changed. Choose its snapshot explicitly.',
      );
      agentProjection(artifact, files);
      await currentAccess(ctx, input.importId, owner, false, true);
      const zone: Doc<'sourceZones'> = await ctx.runMutation(internal.sourceZones.issue, {
        owner,
        importId: input.importId,
        operationId: input.operationId,
        request,
        name,
        sourceId: input.sourceId,
        gitHead: artifact.pack.source.gitHead!,
        artifactKey: job.artifactKey as Id<'_storage'>,
        files,
        enabled: true,
        revision: 0,
      });
      return zone._id;
    } catch (error) {
      return report(error);
    }
  },
});
export const change = action({
  args: {
    id: v.id('sourceZones'),
    operationId: v.string(),
    expectedRevision: v.number(),
    update: zoneUpdate,
  },
  returns: v.object(zoneChange),
  handler: async (ctx, input): Promise<Omit<Doc<'zoneChanges'>, '_id' | '_creationTime'>> => {
    try {
      const owner = await actor(ctx);
      invariant(
        uuid(input.operationId) &&
          Number.isSafeInteger(input.expectedRevision) &&
          input.expectedRevision >= 0,
        'BAD_ARGUMENT',
        'Send the original change operation and observed Zone policy revision.',
      );
      const update =
        input.update.kind === 'reader'
          ? { ...input.update, reader: input.update.reader.trim() }
          : input.update;
      invariant(
        update.kind !== 'reader' || update.reader,
        'BAD_ARGUMENT',
        'Enter an existing Forge user ID.',
      );
      const request = identity({ id: input.id, expectedRevision: input.expectedRevision, update });
      const old = await ctx.runQuery(internal.sourceZones.changed, {
        id: input.id,
        owner,
        operationId: input.operationId,
      });
      if (old) {
        invariant(
          old.request === request,
          'ZONE_OPERATION_CHANGED',
          'Reconcile the original source Zone change.',
        );
        return old;
      }
      if (update.kind === 'reader' && update.present) await checkForgeUser(update.reader);
      return await ctx.runMutation(internal.sourceZones.change, { ...input, owner, request, update });
    } catch (error) {
      return report(error);
    }
  },
});
export const status = action({
  args: { id: v.id('sourceZones'), importId: v.id('imports') },
  returns: v.string(),
  handler: async (ctx, { id, importId }): Promise<string> => {
    try {
      const reader = await actor(ctx),
        { zone, job, repository } = await access(ctx, id, reader);
      invariant(
        zone.importId === importId,
        'ZONE_UNAVAILABLE',
        'This source Zone belongs to another import.',
      );
      await access(ctx, id, reader);
      return JSON.stringify({
        repository: repository.full_name,
        ref: job.ref,
        visibility: 'private',
        phase: 'ready',
        processed: zone.files.length,
        total: zone.files.length,
        canRefresh: false,
        zone: { id, name: zone.name, head: zone.gitHead },
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const read = action({
  args: { id: v.id('sourceZones'), endpoint: v.string() },
  returns: v.string(),
  handler: async (ctx, { id, endpoint }): Promise<string> => {
    try {
      const reader = await actor(ctx),
        isStatus = endpoint.split('?')[0] === 'status';
      const source = await access(ctx, id, reader),
        { zone, job, repository, token } = source;
      let result: unknown, projection: unknown;
      if (isStatus) {
        const record = await derivedArtifact(
          ctx,
          zone.artifactKey,
          'zone-status-v1',
          projectionPin(zone),
          async () => {
            const { scoped } = await projectSource(ctx, id, source);
            return JSON.stringify({
              status: hostedQuery(scoped, 'status', zone.gitHead),
              projection: scoped.projection,
            });
          },
          () => access(ctx, id, reader),
        );
        invariant(record, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
        const stored = JSON.parse(Buffer.from(await derivedBytes(ctx, record)).toString('utf8')) as {
          status: HostedStatus;
          projection: unknown;
        };
        result = hostedStatus(stored.status, endpoint, zone.gitHead);
        projection = stored.projection;
      } else {
        const { scoped } = await projectSource(ctx, id, source);
        projection = scoped.projection;
        // Query after observing upstream below, preserving existing stale-source behavior.
        result = scoped;
      }
      const latest = await githubJson<{ sha: string }>(
        `/repos/${repository.full_name}/commits/${encodeURIComponent(job.ref)}`,
        token,
      ).catch(error => {
        if (error instanceof ForgeError && error.code === 'GITHUB_UNAVAILABLE') return null;
        throw error;
      });
      invariant(
        latest === null || /^[a-f0-9]{40,64}$/.test(latest.sha),
        'GITHUB_RESPONSE',
        'GitHub returned an invalid source revision.',
      );
      if (!isStatus)
        result = hostedQuery(
          result as Parameters<typeof hostedQuery>[0],
          endpoint,
          latest?.sha ?? zone.gitHead,
        );
      await access(ctx, id, reader);
      if (endpoint.split('?')[0] === 'home' || endpoint.split('?')[0] === 'readme')
        return JSON.stringify({
          file: null,
          text: 'This source Zone includes selected source files. Repository documents are not included.',
          scope: 'file-zone-projection',
        });
      return JSON.stringify({
        ...(result as object),
        ...(endpoint.split('?')[0] === 'status'
          ? { freshness: 'current', currentGitHead: zone.gitHead }
          : {}),
        zone: projection,
        pinned: true,
        upstreamHead: latest?.sha ?? null,
        upstreamFreshness: latest === null ? 'unknown' : latest.sha === zone.gitHead ? 'current' : 'stale',
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const downloadPart = action({
  args: { id: v.id('sourceZones'), offset: v.number(), digest: v.optional(v.string()) },
  returns: v.object({
    ...directDownloadFields,
    data: v.bytes(),
    size: v.number(),
    digest: v.string(),
    contentType: v.string(),
    repository: v.string(),
    head: v.string(),
  }),
  handler: async (
    ctx,
    { id, offset, digest: expected },
  ): Promise<{
    direct?: boolean;
    url?: string;
    data: ArrayBuffer;
    size: number;
    digest: string;
    contentType: string;
    repository: string;
    head: string;
  }> => {
    try {
      invariant(Number.isSafeInteger(offset) && offset >= 0, 'BAD_ARGUMENT', 'Invalid download offset.');
      const reader = await actor(ctx),
        { record, zone, job } = await zoneExport(ctx, id, reader);
      invariant(
        !expected || expected === record.digest,
        'STATE_MISMATCH',
        'The source Zone export changed. Download again for one complete snapshot.',
      );
      invariant(offset < record.size, 'BAD_ARGUMENT', 'Download offset exceeds the snapshot.');
      const direct = await archiveDownload(ctx, {
        storageId: record.storageId!,
        size: record.size,
        digest: record.digest,
      });
      const data = direct
        ? direct.data
        : await projectArchivePart(
            ctx,
            record.storageId!,
            record.size,
            record.digest,
            offset,
            () => access(ctx, id, reader),
            'INVALID_ARTIFACT',
          );
      await access(ctx, id, reader);
      return {
        ...direct,
        data,
        size: record.size,
        digest: record.digest,
        contentType: record.contentType,
        repository: job.repository,
        head: zone.gitHead,
      };
    } catch (error) {
      return report(error);
    }
  },
});
const sharedItem = v.object({
  id: v.id('sourceZones'),
  importId: v.id('imports'),
  name: v.string(),
  repository: v.string(),
  head: v.string(),
});
export const shared = action({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(sharedItem),
  handler: async (
    ctx,
    { paginationOpts },
  ): Promise<{ page: Infer<typeof sharedItem>[]; isDone: boolean; continueCursor: string }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      if (!user) return { page: [], isDone: true, continueCursor: '' };
      const result = await ctx.runQuery(internal.sourceZones.candidates, {
          actor: user.subject,
          paginationOpts,
        }),
        page = [];
      for (const id of result.page) {
        try {
          const { zone, job } = await access(ctx, id, user.subject);
          page.push({
            id,
            importId: zone.importId,
            name: zone.name,
            repository: job.repository,
            head: zone.gitHead,
          });
        } catch (error) {
          const code =
            error instanceof ForgeError
              ? error.code
              : error instanceof ConvexError &&
                  typeof error.data === 'object' &&
                  error.data &&
                  'code' in error.data
                ? error.data.code
                : undefined;
          if (!['ZONE_UNAVAILABLE', 'GITHUB_UNAVAILABLE'].includes(String(code))) throw error;
        }
      }
      return { ...result, page };
    } catch (error) {
      return report(error);
    }
  },
});
