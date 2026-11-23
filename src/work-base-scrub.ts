// SPDX-License-Identifier: Apache-2.0
// The base-checkpoint scrub (Item b6588425 lines 2d, 2e): a stored base backup keeps a purged comment's or Item's words in
// content-addressed record objects (and the record packs that cover them), pinned by the backup's exchange root, whose
// record catalog every base reader verifies against the whole-Work digest. A scrub writes a new exchange root: the
// selected records replaced by their purged form (src/work-planning-purge.ts purgedIndexValue, the form the Work index
// and a replay give them), the packs over them rebuilt, the whole-Work digest measured again in one pass over the base,
// and the manifest's work.json pin moved to it. The backup row selects that root (`scrubbed`), the way
// work.recordDetails selects a migrated catalog; every base reader reads the backup's root through backupRootPin and
// checks its manifest against backupManifestDigest. The replaced objects are then tombstoned and deleted with the
// save-purge primitives, so a read of them refuses PURGED. Pure: the server action and the CLI share it.
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { sourceManifestSchema } from './work-archive-metadata.js';
import {
  measureWorkRecords,
  readRecord,
  recordAttributes,
  recordBytes,
  recordReferences,
  workRecordRootSchema,
  type RecordPin,
  type WorkRecordRoot,
} from './work-exchange-records.js';
import { validateRecordPacks, type RecordPack } from './work-record-packs.js';
import {
  buildByteTree,
  exchangeRootSchema,
  isExchangeRoot,
  readByteTree,
  type BytePin,
} from './native-exchange-tree.js';
import { purgeableRowTarget, purgedIndexValue } from './work-planning-purge.js';
import { ObjectRecipeBuilder } from './object-chunks.js';
export {
  backupManifestDigest,
  backupOwnerWork,
  backupRootPin,
  type BackupScrub,
} from './work-backup-root.js';

/** The base catalog's collection name for the Work index's (`events` there is `hostedEvents` in Work). */
const indexCollection = (collection: string) => (collection === 'hostedEvents' ? 'events' : collection);
/** One record in its purged form, as the index and a replay of the purge give it. A fixed point. */
export const scrubbedRecord = (collection: string, value: unknown, purgeOperationId: string) =>
  purgedIndexValue(indexCollection(collection), value, purgeOperationId);
export type ScrubTarget = { collection: string; key: string; transform?: (value: unknown) => unknown };
/** The records of one comment in a base catalog: its comment record and the event that wrote it. */
export const commentScrubTargets = (commentId: string) => [
  { collection: 'planningComments', key: commentId },
  { collection: 'hostedEvents', key: commentId },
];

/** One record of a purged Item in its purged form (line 2e): the Work index's form (purgedIndexValue), and for an
 * Intent record, its notes too (the base keeps them inside the Intent; the index has them as `notes` records). */
export function itemRecordForm(
  collection: string,
  value: unknown,
  purgeOperationId: string,
  decisions: ReadonlyMap<string, string>,
) {
  const out = purgedIndexValue(indexCollection(collection), value, purgeOperationId, decisions);
  if (collection !== 'intents' || !out || typeof out !== 'object' || Array.isArray(out)) return out;
  const intent = out as Record<string, unknown>;
  if (Array.isArray(intent.notes))
    intent.notes = intent.notes.map(note => purgedIndexValue('notes', note, purgeOperationId));
  return intent;
}

/** What a whole-Item purge scrubs in the base (line 2e): every version of the Item ([id, version] for 1..version),
 * every row the purge lists (`rows`, as events), its comments, its Intent and successor Intents (with their notes)
 * and its Initiative record; missing ones are skipped. `check` runs on every record of the scrubbed catalog during
 * the measure pass: a record of the Item (by id, comment Item, event target or Intent) that is not in its purged form
 * refuses the scrub, so nothing is published while a base copy of the words is left. */
export function itemScrub(input: {
  historyId: string;
  ids: readonly string[];
  intentKeys: readonly string[];
  version: number;
  rows: readonly string[];
  comments: readonly string[];
  purgeOperationId: string;
  decisions: ReadonlyMap<string, string>;
}) {
  const ids = new Set(input.ids),
    intents = new Set(input.intentKeys);
  const form = (collection: string) => (value: unknown) =>
    itemRecordForm(collection, value, input.purgeOperationId, input.decisions);
  const targets: ScrubTarget[] = [];
  const add = (collection: string, keys: Iterable<string>) => {
    for (const key of keys) targets.push({ collection, key, transform: form(collection) });
  };
  add(
    'planningItems',
    Array.from({ length: input.version }, (_, index) => JSON.stringify([input.historyId, index + 1])),
  );
  add('hostedEvents', input.rows);
  add('planningComments', input.comments);
  add('intents', intents);
  add('initiatives', ids);
  const needles = [...new Set([...ids, ...intents])].map(id => Buffer.from(id));
  const owned = (collection: string, value: Record<string, unknown>) =>
    collection === 'planningItems' || collection === 'initiatives'
      ? ids.has(String(value.id))
      : collection === 'planningComments'
        ? ids.has(String(value.itemId))
        : collection === 'intents'
          ? intents.has(String(value.id))
          : collection === 'hostedEvents'
            ? ids.has(purgeableRowTarget(String(value.id), value.command)?.id ?? '')
            : false;
  const check = (collection: string, bytes: Buffer) => {
    if (!scrubbedCollections.has(collection) || !needles.some(needle => bytes.includes(needle))) return;
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!owned(collection, value)) return;
    invariant(
      recordBytes(form(collection)(value)).equals(bytes),
      'BAD_ARGUMENT',
      'A record of this Item in the base checkpoint is not on the purge’s list (for example a comment written through an alias), so the base was not rewritten. Nothing was removed from the base.',
    );
  };
  // A base converted to Intents keeps the pre-conversion planning records inline in the catalog
  // (src/work-intent-converter.ts legacyIntentMerge): the Item's are replaced there too. Complete by construction:
  // every record of the three collections it owns takes its purged form. Its extension `fields` stay opaque.
  const legacyOwned = (collection: string, value: Record<string, unknown>) =>
    owned(collection, value) || (collection === 'intents' && ids.has(String(value.id)));
  const fields = (name: string, value: unknown) => {
    if (name !== 'legacyIntentMerge' || !value || typeof value !== 'object' || Array.isArray(value))
      return value;
    const legacy = { ...(value as Record<string, unknown>) };
    for (const collection of ['planningItems', 'planningComments', 'intents'] as const) {
      const records = legacy[collection];
      if (!Array.isArray(records)) continue;
      legacy[collection] = records.map(record =>
        record && typeof record === 'object' && legacyOwned(collection, record as Record<string, unknown>)
          ? form(collection)(record)
          : record,
      );
    }
    return legacy;
  };
  return { targets, check, fields };
}
const scrubbedCollections = new Set([
  'planningItems',
  'initiatives',
  'planningComments',
  'intents',
  'hostedEvents',
]);

const manifestText = (bytes: Buffer) => {
  const text = bytes.toString('utf8');
  const value = JSON.parse(text) as unknown;
  const pretty = JSON.stringify(value, null, 2) + '\n';
  invariant(
    text === pretty || text === JSON.stringify(value),
    'INVALID_WORK_BACKUP',
    'The base manifest is not in a form the scrub can rewrite. Nothing was purged.',
  );
  return (next: unknown) =>
    Buffer.from(text === pretty ? JSON.stringify(next, null, 2) + '\n' : JSON.stringify(next));
};

/** Scrub one exchange root (schema 2, with a record catalog): `targets` are catalog records (collection, key);
 * missing ones are skipped. Returns the new root and every object it needs that the store may not have yet
 * (`objects`), the objects it no longer references that held the replaced words (`replaced`), its manifest digest
 * and whole-Work pin, and how many records changed (undefined: nothing to write). Reads the root's metadata trees, the target
 * records, the packs over them, and every record once (through `read`, in catalog order and batches) to measure the
 * new whole-Work digest. Memory: the catalog and manifest, one pack window, and the new chunks. */
/** The exchange root a scrub can rewrite: schema 2, with a record catalog. Refuses any other (nothing written). */
export function scrubbableRoot(rootBytes: Buffer) {
  const value: unknown = JSON.parse(rootBytes.toString('utf8'));
  invariant(
    isExchangeRoot(value),
    'INVALID_WORK_BACKUP',
    'The base is not a Forge exchange. Nothing was purged.',
  );
  const root = exchangeRootSchema.parse(value);
  invariant(
    root.schema === 2,
    'BAD_ARGUMENT',
    'This base checkpoint is stored whole, with no record catalog, so one record cannot be replaced in it. Nothing was purged.',
  );
  return root;
}

export async function scrubExchange(input: {
  rootBytes: Buffer;
  read: (pins: BytePin[]) => Promise<Buffer[]>;
  /** Catalog records to replace; `transform` gives the new value (default: scrubbedRecord, the purged form). */
  targets: readonly ScrubTarget[];
  purgeOperationId: string;
  originalWork?: string;
  /** Runs on every record of the scrubbed catalog (collection, canonical bytes) during the measure pass. */
  check?: (collection: string, bytes: Buffer) => void;
  /** The new value of an inline catalog field (name, value); unchanged when it returns an equal value. */
  fields?: (name: string, value: unknown) => unknown;
}) {
  const root = scrubbableRoot(input.rootBytes);
  const catalogBytes = await readByteTree(root.records, input.read, { batchSize: 100 });
  const catalog = workRecordRootSchema.parse(JSON.parse(catalogBytes.toString('utf8')));
  const manifestBytes = await readByteTree(root.manifest, input.read, { batchSize: 100 });
  const manifest = sourceManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const work = manifest.files.find(file => file.path === 'work.json');
  invariant(
    work?.sha256 === root.work.sha256 &&
      work.size === root.work.size &&
      catalog.work.sha256 === root.work.sha256 &&
      catalog.work.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'The base record catalog differs from its manifest. Nothing was purged.',
  );
  const schema = catalog.fields.find(field => field.name === 'schema');
  const format = schema && 'value' in schema && typeof schema.value === 'number' ? schema.value : 15;
  const pins = catalog.fields.flatMap(field =>
    'records' in field ? field.records.map(record => ({ field: field.name, record })) : [],
  );
  const position = new Map(
    pins.map((entry, index) => [JSON.stringify([entry.field, entry.record.key]), index]),
  );
  const changedFields = new Map<string, unknown>();
  if (input.fields)
    for (const field of catalog.fields)
      if ('value' in field) {
        const next = input.fields(field.name, field.value);
        if (JSON.stringify(next) !== JSON.stringify(field.value)) changedFields.set(field.name, next);
      }
  const fresh = new Map<string, Buffer>();
  const replacedRecords = new Map<number, { pin: RecordPin; bytes: Buffer }>();
  // The target records present in the catalog, read in batches (a whole Item can name hundreds).
  const found = new Map<number, ScrubTarget>();
  for (const target of input.targets) {
    const at = position.get(JSON.stringify([target.collection, target.key]));
    if (at !== undefined && !found.has(at)) found.set(at, target);
  }
  const positions = [...found.keys()];
  for (let start = 0; start < positions.length; start += 100) {
    const batch = positions.slice(start, start + 100);
    const loaded = await input.read(
      batch.map(at => ({ sha256: pins[at]!.record.sha256, size: pins[at]!.record.size })),
    );
    for (const [i, at] of batch.entries()) {
      const { field, record } = pins[at]!;
      const bytes = loaded[i]!;
      const original = await readRecord(record, async () => bytes, field);
      const transform =
        found.get(at)!.transform ?? (value => scrubbedRecord(field, value, input.purgeOperationId));
      const scrubbed = transform(original) as Record<string, unknown>;
      const next = recordBytes(scrubbed);
      if (next.equals(bytes)) continue;
      const pin: RecordPin = {
        key: record.key,
        sha256: digest(next),
        size: next.length,
        refs: recordReferences(field, scrubbed, format),
        ...recordAttributes(field, scrubbed),
      };
      fresh.set(pin.sha256, next);
      replacedRecords.set(at, { pin, bytes: next });
    }
  }
  if (!replacedRecords.size && !changedFields.size) {
    // Nothing to replace: with a check, one pass still proves the base holds none of the words.
    if (input.check) {
      const records = catalog.fields.flatMap(field => ('records' in field ? field.records : []));
      const fields = catalog.fields.flatMap(field =>
        'records' in field ? field.records.map(() => field.name) : [],
      );
      const packed = packedReader(records, root.recordPacks, input.read);
      let seen = 0;
      await measureWorkRecords(catalog, async pin => {
        const bytes = await packed(pin);
        input.check!(fields[seen++]!, bytes);
        return bytes;
      });
    }
    return undefined;
  }
  const replaced = new Map<string, BytePin>();
  for (const [at] of replacedRecords) {
    const old = pins[at]!.record;
    replaced.set(old.sha256, { sha256: old.sha256, size: old.size });
  }
  const scrubbedCatalog: WorkRecordRoot = {
    ...catalog,
    fields: catalog.fields.map(field => {
      if (!('records' in field))
        return changedFields.has(field.name)
          ? { name: field.name, value: changedFields.get(field.name) }
          : field;
      return {
        name: field.name,
        records: field.records.map(record => {
          const at = position.get(JSON.stringify([field.name, record.key]))!;
          return replacedRecords.get(at)?.pin ?? record;
        }),
      };
    }),
  };
  // Packs over a replaced record are rebuilt from their own bytes with the new record's span in place.
  let packs: RecordPack[] | undefined;
  if (root.recordPacks) {
    validateRecordPacks(catalog, root.recordPacks);
    packs = [];
    for (const pack of root.recordPacks) {
      const inside = [...replacedRecords.keys()].filter(
        at => at >= pack.first && at < pack.first + pack.count,
      );
      if (!inside.length) {
        packs.push(pack);
        continue;
      }
      const [old] = await input.read([{ sha256: pack.sha256, size: pack.size }]);
      invariant(
        old && old.length === pack.size && digest(old) === pack.sha256,
        'INVALID_WORK_BACKUP',
        'A record pack differs from its pin.',
      );
      const parts: Buffer[] = [];
      let offset = 0;
      for (let at = pack.first; at < pack.first + pack.count; at++) {
        const size = pins[at]!.record.size;
        parts.push(replacedRecords.get(at)?.bytes ?? old.subarray(offset, offset + size));
        offset += size + 2;
      }
      const bytes = Buffer.concat(parts.flatMap((part, i) => (i ? [Buffer.from(',\n'), part] : [part])));
      const sha256 = digest(bytes);
      fresh.set(sha256, bytes);
      replaced.set(pack.sha256, { sha256: pack.sha256, size: pack.size });
      packs.push({ first: pack.first, count: pack.count, sha256, size: bytes.length });
    }
    validateRecordPacks(scrubbedCatalog, packs);
  }
  // One pass over every record (packed where the root packs them) measures the new whole-Work digest.
  const records = scrubbedCatalog.fields.flatMap(field => ('records' in field ? field.records : []));
  const overlay = async (batch: BytePin[]) => {
    const missing = batch.filter(pin => !fresh.has(pin.sha256));
    const loaded = missing.length ? await input.read(missing) : [];
    const found = new Map(missing.map((pin, i) => [pin.sha256, loaded[i]!]));
    return batch.map(pin => fresh.get(pin.sha256) ?? found.get(pin.sha256)!);
  };
  const packed = packedReader(records, packs, overlay);
  const fields = scrubbedCatalog.fields.flatMap(field =>
    'records' in field ? field.records.map(() => field.name) : [],
  );
  let seen = 0;
  const reader = input.check
    ? async (pin: BytePin) => {
        const bytes = await packed(pin);
        input.check!(fields[seen++]!, bytes);
        return bytes;
      }
    : packed;
  // The scrubbed Work chunked as a seed's recipe would chunk it: an old whole-Work chunk it repeats holds none of the
  // words, so it is never tombstoned (another object may name it). Compact: one digest per chunk.
  const workChunks = new Set<string>();
  const chunker = new ObjectRecipeBuilder(bytes => {
    const sha256 = digest(bytes);
    workChunks.add(sha256);
    return { sha256, size: bytes.length };
  });
  const measured = await measureWorkRecords(
    { ...scrubbedCatalog, work: { sha256: '0'.repeat(64), size: 0 } },
    reader,
    bytes => chunker.update(bytes),
  );
  chunker.finish(measured);
  scrubbedCatalog.work = measured;
  const rewrite = manifestText(manifestBytes);
  const nextManifest = rewrite({
    ...JSON.parse(manifestBytes.toString('utf8')),
    files: manifest.files.map(file => (file.path === 'work.json' ? { ...file, ...measured } : file)),
  });
  const objects = new Map<string, Buffer>(fresh);
  const nextCatalog = new Map<string, Buffer>();
  const recordsTree = buildByteTree(Buffer.from(JSON.stringify(scrubbedCatalog)), nextCatalog);
  for (const [sha256, bytes] of nextCatalog) objects.set(sha256, bytes);
  const scrubbedRoot = {
    ...root,
    manifest: buildByteTree(nextManifest, objects),
    work: measured,
    records: recordsTree,
    ...(packs ? { recordPacks: packs } : {}),
  };
  // A delta names records against a baseline Work; the scrubbed root has none (readers fall back to its catalog).
  delete (scrubbedRoot as { delta?: unknown }).delta;
  const bytes = Buffer.from(JSON.stringify(exchangeRootSchema.parse(scrubbedRoot)));
  objects.set(digest(bytes), bytes);
  // Tree chunks the original root already has are stored: only new ones go up (the trees chunk by content).
  const stored = new Map<string, Buffer>();
  buildByteTree(catalogBytes, stored);
  buildByteTree(manifestBytes, stored);
  for (const sha256 of stored.keys()) if (!fresh.has(sha256)) objects.delete(sha256);
  // A changed inline field (the legacy merge copy) held words in the old catalog's own tree chunks.
  const catalogChunks = new Set<string>();
  if (changedFields.size) {
    const oldCatalog = new Map<string, Buffer>();
    buildByteTree(catalogBytes, oldCatalog);
    for (const [sha256, bytes] of oldCatalog)
      if (!nextCatalog.has(sha256)) {
        replaced.set(sha256, { sha256, size: bytes.length });
        catalogChunks.add(sha256);
      }
  }
  // Never delete an object the new root still names (a record whose bytes another record shares).
  const kept = new Set(records.map(record => record.sha256).concat(packs?.map(pack => pack.sha256) ?? []));
  return {
    changed: replacedRecords.size + changedFields.size,
    root: { sha256: digest(bytes), size: bytes.length },
    manifestDigest: digest(nextManifest),
    originalWork: input.originalWork ?? root.work.sha256,
    work: measured,
    /** The old root's whole-Work pin: a compatibility download may have cached it whole (convex/projectExchangeActions.ts). */
    previousWork: root.work,
    objects,
    replaced: [...replaced.values()].filter(pin => !kept.has(pin.sha256)),
    /** The old catalog's tree (its root digest, and the chunks of it replaced): a backup naming the same catalog
     * keeps them. */
    catalog: { root: root.records.sha256, chunks: catalogChunks },
    /** Chunk and page digests of the scrubbed whole Work as a recipe (an old chunk it repeats holds no words). */
    workChunks,
    /** Whether the new root names this object (it must stay stored). */
    keeps: (sha256: string) => kept.has(sha256) || objects.has(sha256),
    records: records.length,
    packs: packs?.length ?? 0,
  };
}

/** Records in catalog order, read by pack or by pins, in batches of at most 100 objects and 8 MiB (one object resolve
 * query and one R2 read per object each): linear in the base. */
function packedReader(
  records: RecordPin[],
  packs: RecordPack[] | undefined,
  read: (pins: BytePin[]) => Promise<Buffer[]>,
) {
  let position = 0,
    window: Buffer[] = [],
    start = 0,
    nextPack = 0;
  const fill = async () => {
    start = position;
    window = [];
    const batch: BytePin[] = [];
    let size = 0;
    if (packs) {
      const taken: RecordPack[] = [];
      while (nextPack < packs.length && batch.length < 100) {
        const pack = packs[nextPack]!;
        if (batch.length && size + pack.size > 8 * 1024 * 1024) break;
        invariant(
          pack.first === position + taken.reduce((sum, item) => sum + item.count, 0),
          'INVALID_WORK_BACKUP',
          'Record packs are out of catalog order.',
        );
        taken.push(pack);
        batch.push({ sha256: pack.sha256, size: pack.size });
        size += pack.size;
        nextPack++;
      }
      const loaded = await read(batch);
      taken.forEach((pack, i) => {
        const bytes = loaded[i];
        invariant(
          bytes && bytes.length === pack.size && digest(bytes) === pack.sha256,
          'INVALID_WORK_BACKUP',
          'A record pack differs from its pin.',
        );
        let offset = 0;
        for (let at = pack.first; at < pack.first + pack.count; at++) {
          window.push(bytes.subarray(offset, offset + records[at]!.size));
          offset += records[at]!.size + 2;
        }
      });
    } else {
      for (let at = position; at < records.length && batch.length < 100; at++) {
        if (batch.length && size + records[at]!.size > 8 * 1024 * 1024) break;
        batch.push({ sha256: records[at]!.sha256, size: records[at]!.size });
        size += records[at]!.size;
      }
      window = await read(batch);
    }
  };
  return async (pin: BytePin) => {
    if (position - start >= window.length) await fill();
    const expected = records[position]!;
    invariant(
      expected.sha256 === pin.sha256 && expected.size === pin.size,
      'INVALID_WORK_BACKUP',
      'Record traversal order changed.',
    );
    return window[position++ - start]!;
  };
}
