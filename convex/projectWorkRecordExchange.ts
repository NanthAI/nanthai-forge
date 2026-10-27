// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { exchangeObjectReader, type ExchangeObjectReader } from './projectExchangeReader';
import { exchangeRootSchema, isExchangeRoot, readByteTree } from '../src/native-exchange-tree';
import {
  buildWorkRecords,
  hashWorkRecords,
  recordMap,
  recordMetadata,
  workRecordRootSchema,
  type WorkRecordRoot,
} from '../src/work-exchange-records';
import {
  validateWorkDelta,
  validateChangedRecords,
  channelMetadataChanges,
  supportsWorkDelta,
  WORK_DELTA_BYTES,
} from '../src/work-exchange-delta';
import { batchedRecordReader } from '../src/native-exchange-stream';
import { workDeltaContext } from '../src/work-exchange-context';
import { sourceManifestSchema, archiveChannels } from '../src/work-archive-metadata';
import { invariant } from '../src/errors';
import { digest } from '../src/hash';
import type { RecordPack } from '../src/work-record-packs';
import type { WorkData } from '../src/work-types';
// Publication needs changed records and their validated reference context, not
// both complete Work snapshots. Keep this byte window independent of delta JSON.
const PUBLICATION_CONTEXT_BYTES = 32 * 1024 * 1024;
export async function recordExchange(
  backup: Pick<Doc<'projectBackups'>, 'projectId' | 'digest' | 'size' | 'objectManifest'>,
  owner: string,
  reader: ExchangeObjectReader,
  bodyBudget = 8 * 1024 * 1024,
) {
  // Reuse authenticated record bodies across the validation phases of this one
  // action. This cache never serves a source-read endpoint or another action;
  // publication/source-return commits recheck current authority and exact pins.
  // The underlying reader still checks authority on every actual storage read.
  const bodies = new Map<string, Promise<Buffer>>();
  let retained = 0;
  const readMany = async (pins: { sha256: string; size: number }[]) => {
    const missing = pins.filter(pin => !bodies.has(JSON.stringify([pin.sha256, pin.size])));
    if (missing.length) {
      const bytes = await reader.read(backup.projectId, owner, missing);
      for (const [index, pin] of missing.entries()) {
        if (retained + pin.size > bodyBudget) continue;
        retained += pin.size;
        bodies.set(JSON.stringify([pin.sha256, pin.size]), Promise.resolve(bytes[index]!));
      }
      const loaded = new Map(
        missing.map((pin, index) => [JSON.stringify([pin.sha256, pin.size]), bytes[index]!]),
      );
      return Promise.all(
        pins.map(
          pin =>
            bodies.get(JSON.stringify([pin.sha256, pin.size])) ??
            Promise.resolve(loaded.get(JSON.stringify([pin.sha256, pin.size]))!),
        ),
      );
    }
    return Promise.all(pins.map(pin => bodies.get(JSON.stringify([pin.sha256, pin.size]))!));
  };
  const read = (pin: { sha256: string; size: number }) => {
    const key = JSON.stringify([pin.sha256, pin.size]);
    const existing = bodies.get(key);
    if (existing) return existing;
    const result = reader.read(backup.projectId, owner, [pin]).then(bytes => bytes[0]!);
    if (retained + pin.size <= bodyBudget) {
      retained += pin.size;
      bodies.set(key, result);
      result.catch(() => {
        bodies.delete(key);
        retained -= pin.size;
      });
    }
    return result;
  };
  const bytes = await read({
    sha256: backup.objectManifest?.digest ?? backup.digest,
    size: backup.objectManifest?.size ?? backup.size,
  });
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isExchangeRoot(value)) return;
  const root = exchangeRootSchema.parse(value);
  if (root.schema !== 2) return;
  // Metadata uses small content-defined chunks. Amortize their current-authority
  // lookups across at most 100 pins; byteTreeChunks still bounds each batch to
  // 2 MiB and verifies every chunk and the complete logical digest.
  const metadataOptions = { batchSize: 100 };
  const recordBytes = await readByteTree(
    root.records,
    pins => reader.read(backup.projectId, owner, pins),
    metadataOptions,
  );
  const records = workRecordRootSchema.parse(JSON.parse(recordBytes.toString('utf8')));
  recordMap(records);
  invariant(
    records.work.sha256 === root.work.sha256 && records.work.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'Exchange record root differs from logical Work.',
  );
  const manifestBytes = await readByteTree(
    root.manifest,
    pins => reader.read(backup.projectId, owner, pins),
    metadataOptions,
  );
  const manifest = sourceManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  invariant(
    new Set(manifest.files.map(pin => pin.path)).size === manifest.files.length,
    'INVALID_WORK_BACKUP',
    'Manifest repeats a logical path.',
  );
  const sizes = new Map<string, number>();
  for (const pin of manifest.files) {
    invariant(
      !sizes.has(pin.sha256) || sizes.get(pin.sha256) === pin.size,
      'INVALID_WORK_BACKUP',
      'Identical content has inconsistent sizes.',
    );
    sizes.set(pin.sha256, pin.size);
  }
  const work = manifest.files.find(pin => pin.path === 'work.json'),
    metadata = recordMetadata(records);
  invariant(
    work?.sha256 === records.work.sha256 &&
      work.size === records.work.size &&
      metadata.revision === records.revision &&
      manifest.revision === records.revision &&
      manifest.kind === 'forge-native-work-backup' &&
      metadata.nativeHead === manifest.head,
    'INVALID_WORK_BACKUP',
    'Work record source or revision differs from its manifest.',
  );
  return {
    root,
    records,
    manifest,
    manifestBytes,
    read,
    readMany,
    releaseBodies() {
      bodies.clear();
      retained = 0;
    },
  };
}
export async function verifyRecordSeed(
  exchange: NonNullable<Awaited<ReturnType<typeof recordExchange>>>,
  validatedWork: Uint8Array | WorkData,
) {
  // The caller has validated these complete bytes. Rebuild from their original
  // field order: parseWorkBytes adds defaults and orders known fields by schema,
  // which can change a catalog even when the Work values and revision match.
  const data =
    validatedWork instanceof Uint8Array
      ? (JSON.parse(Buffer.from(validatedWork).toString('utf8')) as WorkData)
      : validatedWork;
  const expected = buildWorkRecords(data, { retainObjects: false });
  invariant(
    expected &&
      expected.pin.sha256 === exchange.root.records.sha256 &&
      expected.pin.size === exchange.root.records.size,
    'INVALID_WORK_BACKUP',
    'Record exchange differs from its validated complete Work.',
  );
}
/** Stream canonical bytes in bounded read batches; validation parses only changed records. */
export async function verifyRecordDigest(
  records: WorkRecordRoot,
  reader: ExchangeObjectReader,
  backup: Pick<Doc<'projectBackups'>, 'projectId'>,
  owner: string,
  packs?: RecordPack[],
) {
  const batch = batchedRecordReader(records, pins => reader.read(backup.projectId, owner, pins), packs);
  try {
    await hashWorkRecords(records, batch.read);
  } finally {
    await batch.drain();
  }
}
export async function recordPublication(
  ctx: ActionCtx,
  input: {
    projectId: Doc<'projectBackups'>['projectId'];
    previous: Doc<'projectBackups'>['_id'] | null;
    digest: string;
    size: number;
    deferHistory?: boolean;
  },
  owner: string,
  reader: ExchangeObjectReader,
) {
  const skip = (reason: string) => {
    console.log('work-record publication skip', { reason, projectId: input.projectId });
    return { unavailable: reason };
  };
  if (!input.previous) return skip('previous-missing');
  if (input.deferHistory) return skip('history-deferred');
  let { backup: prior } = await ctx.runQuery(internal.projectBackups.get, { id: input.previous, owner });
  if (prior.projectId !== input.projectId) return skip('previous-project-differs');
  const usable = (backup: Doc<'projectBackups'>) =>
    backup.projectId === input.projectId &&
    backup.validatedWorkRecords === 1 &&
    backup.validatedClosure === 1 &&
    !backup.historyBackfilling;
  let selectedBase: Doc<'projectBackups'> | undefined;
  const alternativeBase = async () => {
    if (selectedBase) return selectedBase;
    const project = await ctx.runQuery(internal.projectWork.get, { projectId: input.projectId, owner });
    const id = project.work?.backupId;
    if (!id || id === input.previous) return;
    return (selectedBase = (await ctx.runQuery(internal.projectBackups.get, { id, owner })).backup);
  };
  if (!usable(prior)) {
    const selected = await alternativeBase();
    if (!selected)
      return skip(
        prior.validatedWorkRecords !== 1
          ? 'previous-records-unvalidated'
          : prior.validatedClosure !== 1
            ? 'previous-closure-unvalidated'
            : 'previous-history-backfilling',
      );
    if (!usable(selected)) return skip('selected-base-unvalidated');
  }
  const candidate = await recordExchange(input, owner, reader, PUBLICATION_CONTEXT_BYTES);
  if (!candidate) return skip('candidate-catalog-unavailable');
  if (!candidate.root.delta) return skip('delta-missing');
  if (candidate.root.delta.size > WORK_DELTA_BYTES) return skip('delta-over-budget');
  const raw = JSON.parse((await candidate.read(candidate.root.delta)).toString('utf8'));
  let previous = usable(prior) ? await recordExchange(prior, owner, reader) : undefined;
  const missingReason =
    prior.validatedWorkRecords !== 1
      ? 'previous-records-unvalidated'
      : prior.validatedClosure !== 1
        ? 'previous-closure-unvalidated'
        : prior.historyBackfilling
          ? 'previous-history-backfilling'
          : !previous
            ? 'previous-catalog-unavailable'
            : 'delta-base-root-differs';
  if (!previous || raw?.base?.root !== previous.root.records.sha256) {
    // Publication CAS follows currentBackup, including a superseded upload.
    // The owner prepares its delta against selected hosted Work instead. These
    // pins intentionally differ until source return commits the replacement.
    const selected = await alternativeBase();
    if (!selected) return skip(missingReason);
    if (!usable(selected)) return skip('selected-base-unvalidated');
    const base = await recordExchange(selected, owner, reader);
    if (!base || raw?.base?.root !== base.root.records.sha256) return skip('delta-base-root-differs');
    prior = selected;
    previous = base;
  }
  const delta = validateWorkDelta(previous.records, candidate.records, raw, {
    root: previous.root.records.sha256,
  });
  if (!supportsWorkDelta(previous.records, candidate.records)) return skip('delta-layout-unsupported');
  const metadataOnly = await channelMetadataChanges(
    previous.records,
    candidate.records,
    delta.changes,
    candidate.read,
  );
  if (
    !(await workDeltaContext(previous.records, candidate.records, delta, candidate.read, [], metadataOnly, {
      maxBytes: PUBLICATION_CONTEXT_BYTES,
      prefetchOnly: true,
      readMany: candidate.readMany,
    }))
  )
    return skip('context-over-budget');
  const files = new Map(
    previous.manifest.files.filter(p => p.path !== 'work.json').map(p => [p.sha256, p.size]),
  );
  const pins = new Set(
    candidate.manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => p.sha256),
  );
  const validated = await validateChangedRecords(
    previous.records,
    candidate.records,
    delta.changes,
    candidate.read,
    pins,
    metadataOnly,
  );
  if (
    delta.changes.some(
      change =>
        change.collection === 'channelMoves' &&
        change.previous !== null &&
        !metadataOnly.has(JSON.stringify([change.collection, change.key])),
    )
  )
    return skip('channel-history-replaced');
  candidate.releaseBodies();
  // Digest traversal consumes every pack once; retaining a second byte memo
  // wastes action memory without avoiding any storage/authority reads.
  await verifyRecordDigest(
    candidate.records,
    exchangeObjectReader(ctx, false, 0),
    input,
    owner,
    candidate.root.recordPacks,
  );
  const channels = new Map(
    prior.preview.channels.map((channel: { name: string; head: string }) => [channel.name, channel]),
  );
  for (const move of archiveChannels(candidate.manifest, validated.current)) channels.set(move.name, move);
  console.log('work-record exchange prepared', { recordsValidated: validated.validated, mode: 'delta' });
  return {
    preview: {
      manifestDigest: digest(candidate.manifestBytes),
      head: candidate.manifest.head,
      format: 'native' as const,
      revision: candidate.records.revision,
      intents: count(candidate.records, 'intents'),
      lanes: count(candidate.records, 'lanes'),
      views: count(candidate.records, 'views'),
      runs: count(candidate.records, 'runs'),
      files: candidate.manifest.files.length,
      unavailable: candidate.manifest.unavailable.length,
      channels: [...channels.values()],
    },
    contentPins: candidate.manifest.files.filter(
      p => p.path !== 'work.json' && files.get(p.sha256) !== p.size,
    ),
  };
}
const count = (root: WorkRecordRoot, name: string) => {
  const field = root.fields.find(f => f.name === name);
  return field && 'records' in field ? field.records.length : 0;
};
