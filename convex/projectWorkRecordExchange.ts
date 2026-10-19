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
  supportsWorkDelta,
  WORK_DELTA_BYTES,
} from '../src/work-exchange-delta';
import { workDeltaContext } from '../src/work-exchange-context';
import { sourceManifestSchema, archiveChannels } from '../src/work-archive-metadata';
import { invariant } from '../src/errors';
import { digest } from '../src/hash';
import type { WorkData } from '../src/work-types';
export async function recordExchange(
  backup: Pick<Doc<'projectBackups'>, 'projectId' | 'digest' | 'size' | 'objectManifest'>,
  owner: string,
  reader: ExchangeObjectReader,
) {
  const read = async (pin: { sha256: string; size: number }) =>
    (await reader.read(backup.projectId, owner, [pin]))[0]!;
  const bytes = await read({
    sha256: backup.objectManifest?.digest ?? backup.digest,
    size: backup.objectManifest?.size ?? backup.size,
  });
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isExchangeRoot(value)) return;
  const root = exchangeRootSchema.parse(value);
  if (root.schema !== 2 || root.records.size > WORK_DELTA_BYTES) return;
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
  validatedWork: Uint8Array,
) {
  // The caller has validated these complete bytes. Rebuild from their original
  // field order: parseWorkBytes adds defaults and orders known fields by schema,
  // which can change a catalog even when the Work values and revision match.
  const data = JSON.parse(Buffer.from(validatedWork).toString('utf8')) as WorkData;
  const expected = buildWorkRecords(data);
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
) {
  const pins = [...recordMap(records).values()].map(({ record }) => record);
  let position = 0;
  const cache = new Map<string, Buffer>();
  await hashWorkRecords(records, async pin => {
    const current = position++;
    if (!cache.has(pin.sha256)) {
      cache.clear();
      const batch = [];
      let bytes = 0,
        offset = current;
      while (
        offset < pins.length &&
        batch.length < 100 &&
        (!batch.length || bytes + pins[offset]!.size <= 2 * 1024 * 1024)
      ) {
        const next = pins[offset++]!;
        batch.push(next);
        bytes += next.size;
      }
      const values = await reader.read(backup.projectId, owner, batch);
      batch.forEach((item, i) => cache.set(item.sha256, values[i]!));
    }
    const value = cache.get(pin.sha256);
    // Repeated content is legal; an earlier consumed record can be read again.
    cache.delete(pin.sha256);
    return value ?? (await reader.read(backup.projectId, owner, [pin]))[0]!;
  });
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
  if (!input.previous || input.deferHistory) return;
  const { backup: prior } = await ctx.runQuery(internal.projectBackups.get, { id: input.previous, owner });
  if (
    prior.projectId !== input.projectId ||
    prior.validatedWorkRecords !== 1 ||
    prior.validatedClosure !== 1 ||
    prior.historyBackfilling
  )
    return;
  const candidate = await recordExchange(input, owner, reader),
    previous = await recordExchange(prior, owner, reader);
  if (!candidate?.root.delta || !previous || candidate.root.delta.size > WORK_DELTA_BYTES) return;
  const raw = JSON.parse((await candidate.read(candidate.root.delta)).toString('utf8'));
  // A checkpoint from another baseline uses the complete supported path.
  if (raw?.base?.root !== previous.root.records.sha256) return;
  const delta = validateWorkDelta(previous.records, candidate.records, raw, {
    root: previous.root.records.sha256,
  });
  if (!supportsWorkDelta(previous.records, candidate.records)) return;
  if (!(await workDeltaContext(previous.records, candidate.records, delta, candidate.read))) return;
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
  );
  if (delta.changes.some(change => change.collection === 'channelMoves' && change.previous !== null)) return;
  await verifyRecordDigest(candidate.records, reader, input, owner);
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
