// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Id, Doc } from './_generated/dataModel';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { sourceManifestSchema, archiveChannels } from '../src/work-archive-metadata';
import { parseNativeState } from '../src/native-source';
import { hostSourceHeads } from '../src/host-source';
import { validateExchangePins, validateHostedClosure } from './projectExchangeValidation';
import { validateParsedWork } from '../src/work-metadata';
import { resolveExchangeWork } from '../src/native-exchange-stream';
import { projectArchivePart } from './projectArchivePart';
import { objectRange, rawContent } from './projectObjectContent';
import { isStored, isR2Object } from './projectObjectFields';
import { report } from './errors';
import { exchangeObjectReader, bytesFromRow, type ExchangeObjectReader } from './projectExchangeReader';
import { resolveExchangeRoot, isExchangeRoot } from '../src/native-exchange-tree';
import { meteredStorage, storageMeter } from './storageMeter';
import { metadataPublication } from './projectPublicationValidation';
import { recordPublication, recordExchange, verifyRecordSeed } from './projectWorkRecordExchange';

async function caller(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
  return user.subject;
}
export async function objectBytes(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pin: { sha256: string; size: number },
  reader = exchangeObjectReader(ctx, true),
) {
  const [bytes] = await reader.read(projectId, actor, [pin]);
  return bytes!;
}
export const downloadBatch = action({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(v.object({ data: v.bytes(), digest: v.string(), size: v.number() })),
  handler: async (
    ctx,
    { projectId, digests },
  ): Promise<{ data: ArrayBuffer; digest: string; size: number }[]> => {
    try {
      const actor = await caller(ctx);
      invariant(
        digests.length <= 8,
        'BAD_ARGUMENT',
        'Read small content in batches of at most eight; larger content uses ranged downloads.',
      );
      const rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, {
        projectId,
        actor,
        digests,
      });
      invariant(
        rows.reduce((sum, row) => sum + row.size, 0) <= 2 * 1024 * 1024,
        'BAD_ARGUMENT',
        'Use ranged downloads for content larger than the small-content batch.',
      );
      const result = await Promise.all(
        rows.map(async row => ({
          data: new Uint8Array(await bytesFromRow(ctx, row, { sha256: row.digest, size: row.size }, actor))
            .buffer,
          digest: row.digest,
          size: row.size,
        })),
      );
      await ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests });
      return result;
    } catch (error) {
      return report(error);
    }
  },
});

export async function objectByteBatch(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pins: { sha256: string; size: number }[],
  reader = exchangeObjectReader(ctx, true),
) {
  return reader.read(projectId, actor, pins);
}
export async function exchangeMetadata(
  ctx: ActionCtx,
  backup: Doc<'projectBackups'>,
  actor: string,
  reader: ExchangeObjectReader = exchangeObjectReader(ctx, true),
) {
  const root = await objectBytes(
    ctx,
    backup.projectId,
    actor,
    {
      sha256: backup.objectManifest?.digest ?? backup.digest,
      size: backup.objectManifest?.size ?? backup.size,
    },
    reader,
  );
  return resolveExchangeRoot(root, pins => reader.read(backup.projectId, actor, pins), { batchSize: 100 });
}
async function cacheLogicalMetadata(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  bytes: Buffer,
) {
  const prepared = await ctx.runMutation(internal.projectExchangeCache.prepare, {
    projectId,
    actor,
    digest: digest(bytes),
    size: bytes.length,
  });
  if (prepared.stored) return;
  let cursor: string | null = null;
  while (!prepared.created) {
    const receipt: { stored: boolean; done: boolean; cursor: string } = await ctx.runMutation(
      internal.projectExchangeCache.reconcile,
      { id: prepared.id, actor, cursor },
    );
    if (receipt.stored) return;
    if (receipt.done) break;
    cursor = receipt.cursor;
  }
  const storageId = await blobStore(ctx).store(
    new Blob([new Uint8Array(bytes)], { type: prepared.contentType }),
  );
  await ctx.runMutation(internal.projectExchangeCache.complete, { id: prepared.id, actor, storageId });
}
const publicationFields = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  previous: v.union(v.id('projectBackups'), v.null()),
  digest: v.string(),
  size: v.number(),
  deferHistory: v.optional(v.boolean()),
  retainCandidate: v.optional(v.boolean()),
};
type Publication = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  previous: Id<'projectBackups'> | null;
  digest: string;
  size: number;
  deferHistory?: boolean;
  retainCandidate?: boolean;
};
async function publicationReceipt(ctx: ActionCtx, input: Publication) {
  const owner = await caller(ctx);
  await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
  invariant(
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
    'BAD_ARGUMENT',
    'Retain an exchange operation UUID.',
  );
  const request = digest(
    JSON.stringify([
      input.projectId,
      input.operationId,
      input.previous,
      input.digest,
      input.size,
      ...(input.deferHistory ? [true] : []),
      ...(input.retainCandidate ? ['retain-candidate'] : []),
    ]),
  );
  const original: Id<'projectBackups'> | null = await ctx.runQuery(internal.projectExchange.published, {
    projectId: input.projectId,
    owner,
    operationId: input.operationId,
    request,
  });
  return { owner, request, original };
}
export const published = action({
  args: publicationFields,
  returns: v.union(v.id('projectBackups'), v.null()),
  handler: async (ctx, input): Promise<Id<'projectBackups'> | null> => {
    try {
      return (await publicationReceipt(ctx, input)).original;
    } catch (error) {
      return report(error);
    }
  },
});
export const publish = action({
  args: { ...publicationFields, metadataOnly: v.optional(v.literal(1)) },
  returns: v.id('projectBackups'),
  handler: async (ctx, input): Promise<Id<'projectBackups'>> => {
    try {
      const { owner, request, original } = await publicationReceipt(ctx, input);
      if (original) return original;
      const { metadataOnly, ...legacyInput } = input;
      if (metadataOnly) {
        console.log('work-record publication skip', {
          reason: 'metadata-publication',
          projectId: input.projectId,
        });
        const started = Date.now(),
          metadataCtx = meteredStorage(ctx);
        const metadata = await metadataPublication(metadataCtx, input, owner, request);
        const { deferHistory: _deferHistory, ...publication } = legacyInput;
        void _deferHistory;
        const id = await metadataCtx.runMutation(internal.projectExchange.publish, {
          ...publication,
          owner,
          request,
          ...metadata,
          validatedClosure: 1,
        });
        const meter = storageMeter(metadataCtx);
        console.info('metadata-publication complete', {
          projectId: input.projectId,
          operationId: input.operationId,
          elapsedMs: Date.now() - started,
          storageReads: meter.reads,
          storageBytes: meter.bytes,
        });
        return id;
      }
      const reader = exchangeObjectReader(ctx, true);
      const records = await recordPublication(ctx, input, owner, reader);
      if (records) {
        await validateExchangePins(ctx, input.projectId, owner, records.contentPins);
        const { deferHistory: _deferHistory, ...publication } = legacyInput;
        void _deferHistory;
        return await ctx.runMutation(internal.projectExchange.publish, {
          ...publication,
          owner,
          request,
          preview: records.preview,
          validatedClosure: 1,
          validatedWorkRecords: 1,
        });
      }
      const bytes = await objectBytes(
        ctx,
        input.projectId,
        owner,
        { sha256: input.digest, size: input.size },
        // A fresh publication verifies its receipt root from storage even if an
        // earlier attempt or metadata reader warmed the process memo. Descendants
        // still reuse immutable bytes after current metadata/authority checks.
        exchangeObjectReader(ctx),
      );
      const incremental = isExchangeRoot(JSON.parse(bytes.toString('utf8'))),
        resolved = await resolveExchangeWork(bytes, pins => reader.read(input.projectId, owner, pins));
      const manifest = sourceManifestSchema.parse(JSON.parse(resolved.manifest.toString('utf8')));
      invariant(
        new Set(manifest.files.map(file => file.path)).size === manifest.files.length,
        'INVALID_WORK_BACKUP',
        'Manifest repeats a logical path.',
      );
      const workFile = manifest.files.find(file => file.path === 'work.json');
      invariant(workFile, 'INVALID_WORK_BACKUP', 'Manifest omits Work.');
      const data = validateParsedWork(resolved.data);
      const recordSeed = await recordExchange(input, owner, reader);
      if (recordSeed) {
        await verifyRecordSeed(recordSeed, resolved.data);
        console.log('work-record exchange prepared', { mode: 'seed' });
      } else
        console.log('work-record publication skip', {
          reason: 'seed-catalog-unavailable',
          projectId: input.projectId,
        });
      invariant(
        data.revision === manifest.revision &&
          (manifest.kind === 'forge-native-work-backup'
            ? data.nativeHead === manifest.head &&
              manifest.files.some(
                file => file.path === `objects/${manifest.head}` && file.sha256 === manifest.head,
              )
            : manifest.head.length === (manifest.format === 'sha1' ? 40 : 64) &&
              manifest.refs.every(pin => pin.head.length === manifest.head.length) &&
              manifest.files.some(file => file.path === 'source.bundle')),
        'INVALID_WORK_BACKUP',
        'Work/source pins differ from the exchange manifest.',
      );
      let contentPins = manifest.files.filter(file => !incremental || file.path !== 'work.json');
      if (input.deferHistory) {
        const project = await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
        invariant(
          input.previous === null && project.hostingRequest && manifest.kind === 'forge-native-work-backup',
          'BAD_ARGUMENT',
          'Current-first exchange seeds a native hosted project.',
        );
        const required = new Set<string>();
        const heads = hostSourceHeads(data);
        const statePins = heads.map(head => {
          const pin = manifest.files.find(file => file.path === `objects/${head}` && file.sha256 === head);
          invariant(pin, 'INVALID_WORK_BACKUP', 'Current source State is absent from the manifest.');
          required.add(head);
          return pin;
        });
        const states = await reader.read(input.projectId, owner, statePins);
        for (const bytes of states) {
          const state = parseNativeState(bytes);
          for (const file of state.files) required.add(file.blob);
          if (state.git) required.add(state.git.bundle);
        }
        for (const id of required)
          invariant(
            contentPins.some(pin => pin.path === `objects/${id}` && pin.sha256 === id),
            'INVALID_WORK_BACKUP',
            'Current source content is absent from the manifest.',
          );
        contentPins = contentPins.filter(pin => required.has(pin.sha256) || pin.path === 'work.json');
      }
      // Object bindings are immutable for the lifetime of an active project.
      // Only explicit project deletion purges them, and the final publication
      // rechecks that the project is active. A complete prior closure therefore
      // proves unchanged pins without resolving every retained object again.
      if (input.previous && !input.deferHistory) {
        const { backup: previous } = await ctx.runQuery(internal.projectBackups.get, {
          id: input.previous,
          owner,
        });
        invariant(
          previous.projectId === input.projectId,
          'PROJECT_CHANGED',
          'Select this project’s prior checkpoint.',
        );
        if (previous.validatedClosure === 1 && !previous.historyBackfilling) {
          const prior = await exchangeMetadata(ctx, previous, owner, reader);
          const old = sourceManifestSchema.parse(JSON.parse(prior.manifest.toString('utf8')));
          const retained = new Map(
            old.files.filter(pin => pin.path !== 'work.json').map(pin => [pin.sha256, pin.size]),
          );
          contentPins = contentPins.filter(pin => retained.get(pin.sha256) !== pin.size);
        }
      }
      await validateExchangePins(ctx, input.projectId, owner, contentPins);
      const preview = {
        manifestDigest: digest(resolved.manifest),
        head: manifest.head,
        format: manifest.kind === 'forge-native-work-backup' ? ('native' as const) : manifest.format,
        revision: data.revision,
        intents: data.intents.length,
        lanes: data.lanes.length,
        views: data.views.length,
        runs: data.runs.length,
        files: manifest.files.length,
        unavailable: manifest.unavailable.length,
        channels: archiveChannels(manifest, data),
      };
      const { deferHistory, ...publication } = legacyInput;
      return await ctx.runMutation(internal.projectExchange.publish, {
        ...publication,
        owner,
        preview,
        request,
        ...(deferHistory ? { historyBackfilling: true } : { validatedClosure: 1 as const }),
        ...(recordSeed ? { validatedWorkRecords: 1 as const } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
const checkpointReply = v.object({
  json: v.string(),
  digest: v.string(),
  size: v.number(),
  sourceDigest: v.string(),
});
async function checkpointBytes(ctx: ActionCtx, backupId: Id<'projectBackups'>) {
  const actor = await caller(ctx),
    { backup } = await ctx.runQuery(internal.projectBackups.get, { id: backupId, owner: actor });
  invariant(
    backup.transport === 'objects',
    'BAD_ARGUMENT',
    'This checkpoint uses a legacy archive; use its existing download command.',
  );
  const bytes = await objectBytes(ctx, backup.projectId, actor, {
    sha256: backup.objectManifest?.digest ?? backup.digest,
    size: backup.objectManifest?.size ?? backup.size,
  });
  return { actor, backup, bytes };
}
export const checkpoint = action({
  args: { backupId: v.id('projectBackups') },
  returns: checkpointReply,
  handler: async (
    ctx,
    { backupId },
  ): Promise<{ json: string; digest: string; size: number; sourceDigest: string }> => {
    try {
      const { backup, bytes } = await checkpointBytes(ctx, backupId);
      return {
        json: bytes.toString('utf8'),
        digest: digest(bytes),
        size: bytes.length,
        sourceDigest: backup.digest,
      };
    } catch (error) {
      return report(error);
    }
  },
});
// Existing clients explicitly requesting the old endpoint receive the original
// logical files. Full metadata objects are cached only for this compatibility path.
export const manifest = action({
  args: { backupId: v.id('projectBackups') },
  returns: checkpointReply,
  handler: async (
    ctx,
    { backupId },
  ): Promise<{ json: string; digest: string; size: number; sourceDigest: string }> => {
    try {
      const { actor, backup, bytes } = await checkpointBytes(ctx, backupId);
      if (!isExchangeRoot(JSON.parse(bytes.toString('utf8'))))
        return {
          json: bytes.toString('utf8'),
          digest: digest(bytes),
          size: bytes.length,
          sourceDigest: backup.digest,
        };
      const logical = await resolveExchangeRoot(
        bytes,
        pins => objectByteBatch(ctx, backup.projectId, actor, pins),
        { batchSize: 100 },
      );
      await cacheLogicalMetadata(ctx, backup.projectId, actor, logical.work);
      await cacheLogicalMetadata(ctx, backup.projectId, actor, logical.manifest);
      await ctx.runQuery(internal.projectBackups.get, { id: backupId, owner: actor });
      return {
        json: logical.manifest.toString('utf8'),
        digest: digest(logical.manifest),
        size: logical.manifest.length,
        sourceDigest: backup.digest,
      };
    } catch (error) {
      return report(error);
    }
  },
});
const sliceOf = (bytes: Buffer, offset: number) =>
  new Uint8Array(bytes.subarray(offset, offset + 2 * 1024 * 1024)).buffer;
export const downloadPart = action({
  args: { projectId: v.id('hostedProjects'), digest: v.string(), offset: v.number() },
  returns: v.object({ data: v.bytes(), digest: v.string(), size: v.number() }),
  handler: async (
    ctx,
    { projectId, digest, offset },
  ): Promise<{ data: ArrayBuffer; digest: string; size: number }> => {
    try {
      const actor = await caller(ctx),
        rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, {
          projectId,
          actor,
          digests: [digest],
        });
      const row = rows[0]!;
      invariant(
        isStored(row) &&
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          (offset < row.size || (offset === 0 && row.size === 0)),
        'BAD_ARGUMENT',
        'Use an offset inside the selected content.',
      );
      const data =
        row.size === 0
          ? new ArrayBuffer(0)
          : isR2Object(row)
            ? // Fallback for callers that did not sign. Raw R2 objects are small: read whole, slice.
              sliceOf(await rawContent(ctx, row, { sha256: digest, size: row.size }), offset)
            : !row.storageId
              ? await objectRange(ctx, row, actor, offset)
              : await projectArchivePart(ctx, row.storageId, row.size, digest, offset, () =>
                  ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests: [digest] }),
                );
      await ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests: [digest] });
      return { data, digest, size: row.size };
    } catch (error) {
      return report(error);
    }
  },
});

/** Completion validates the same immutable manifest; it never moves hosted Work,
 * overwrites hosted edits, changes the source generation or rewinds a newer push. */
export const completeHistory = action({
  args: { backupId: v.id('projectBackups') },
  returns: v.null(),
  handler: async (ctx, { backupId }) => {
    try {
      const actor = await caller(ctx);
      const { backup } = await ctx.runQuery(internal.projectBackups.get, { id: backupId, owner: actor });
      await ctx.runQuery(internal.projectWork.owner, { projectId: backup.projectId, owner: actor });
      if (!backup.historyBackfilling) return null;
      const resolved = await exchangeMetadata(ctx, backup, actor);
      const manifest = sourceManifestSchema.parse(JSON.parse(resolved.manifest.toString('utf8')));
      await validateHostedClosure(
        ctx,
        backup.projectId,
        actor,
        manifest.files.filter(pin => pin.path !== 'work.json'),
      );
      await ctx.runMutation(internal.projectExchange.completeHistory, { backupId, owner: actor });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
