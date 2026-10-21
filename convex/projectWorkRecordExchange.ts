// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { ExchangeObjectReader } from './projectExchangeReader';
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
export async function recordExchange(
  backup: Pick<Doc<'projectBackups'>, 'projectId' | 'digest' | 'size' | 'objectManifest'>,
  owner: string,
  reader: ExchangeObjectReader,
) {
  // Reuse authenticated record bodies across the validation phases of this one
  // action. This cache never serves a source-read endpoint or another action;
  // publication/source-return commits recheck current authority and exact pins.
  // The underlying reader still checks authority on every actual storage read.
  const bodies = new Map<string, Promise<Buffer>>();
  let retained = 0;
  const read = (pin: { sha256: string; size: number }) => {
    const key = JSON.stringify([pin.sha256, pin.size]);
    const existing = bodies.get(key);
    if (existing) return existing;
    const result = reader.read(backup.projectId, owner, [pin]).then(bytes => bytes[0]!);
    if (retained + pin.size <= 8 * 1024 * 1024) {
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
  const recordBytes = await readByteTree(root.records, pins => reader.read(backup.projectId, owner, pins));
  const records = workRecordRootSchema.parse(JSON.parse(recordBytes.toString('utf8')));
  recordMap(records);
  invariant(
    records.work.sha256 === root.work.sha256 && records.work.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'Exchange record root differs from logical Work.',
  );
  const manifestBytes = await readByteTree(root.manifest, pins => reader.read(backup.projectId, owner, pins));
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
  return { root, records, manifest, manifestBytes, read };
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
    return undefined;
  };
  if (!input.previous) return skip('previous-missing');
  if (input.deferHistory) return skip('history-deferred');
  const { backup: prior } = await ctx.runQuery(internal.projectBackups.get, { id: input.previous, owner });
  if (prior.projectId !== input.projectId) return skip('previous-project-differs');
  if (prior.validatedWorkRecords !== 1) return skip('previous-records-unvalidated');
  if (prior.validatedClosure !== 1) return skip('previous-closure-unvalidated');
  if (prior.historyBackfilling) return skip('previous-history-backfilling');
  const candidate = await recordExchange(input, owner, reader),
    previous = await recordExchange(prior, owner, reader);
  if (!candidate) return skip('candidate-catalog-unavailable');
  if (!previous) return skip('previous-catalog-unavailable');
  if (!candidate.root.delta) return skip('delta-missing');
  if (candidate.root.delta.size > WORK_DELTA_BYTES) return skip('delta-over-budget');
  const raw = JSON.parse((await candidate.read(candidate.root.delta)).toString('utf8'));
  // A checkpoint from another baseline uses the complete supported path.
  if (raw?.base?.root !== previous.root.records.sha256) return skip('delta-base-root-differs');
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
  if (!(await workDeltaContext(previous.records, candidate.records, delta, candidate.read, [], metadataOnly)))
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
  await verifyRecordDigest(candidate.records, reader, input, owner, candidate.root.recordPacks);
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
