// SPDX-License-Identifier: Apache-2.0
import { compactDetailPage, slimWorkFormat } from './work-record-details.js';
import { detailReader, detailWriter } from './work-detail-store.js';
import { readWorkPointer } from './work-pointer.js';
import { pendingRecordWriter } from './work-record-staging.js';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { packRecord, unpackRecord } from './work-record-codec.js';
import { preparePendingExchange } from './pending-exchange.js';
import { recordOwnerMutation } from './self-metrics-journal.js';
import { z } from 'zod';
import { digest } from './hash.js';
import { readSource } from './files.js';
import { assertWorkFormat } from './work-format.js';
import { invariant } from './errors.js';
import { indexBuild, recordKeys, validateIndex, type IndexIO } from './work-record-index.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const collectionSchema = z.object({
  count: z.number().safe().nonnegative(),
  pages: z.array(hash),
  lookup: hash.optional(),
});
export type RecordCollection = z.infer<typeof collectionSchema>;
const manifestSchema = z.object({
  schema: z.enum(['forge-work-records-v1', 'forge-work-records-v2', 'forge-work-records-v3']),
  fields: z.record(z.string(), z.unknown()),
  keys: z.array(z.string()),
  collections: z.record(z.string(), collectionSchema),
});
export type RecordManifest = z.infer<typeof manifestSchema>;
const stagedDetails = new WeakMap<RecordManifest, () => void>();
const fragmentSchema = z
  .object({
    kind: z.literal('forge-work-record-v2'),
    fields: z.record(z.string(), z.unknown()),
    keys: z.array(z.string()),
    arrays: z.record(z.string(), collectionSchema),
  })
  .strict();
export const pageSize = 128;
/** Match portable JSON: omitted optional properties never become retained key slots. */
export function jsonValue(value: unknown): unknown {
  const bytes = JSON.stringify(value);
  return bytes === undefined ? null : JSON.parse(bytes);
}
const code = 'INVALID_WORK_STORE';
export function readWorkFile(directory: string) {
  const bytes = readWorkPointer(directory);
  if (bytes) {
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      return bytes;
    }
    const fields = raw && typeof raw === 'object' && 'fields' in raw ? raw.fields : raw;
    assertWorkFormat(fields);
  }
  return bytes;
}
type ReadMemo = {
  json: Map<string, string>;
  collections: Map<string, unknown[]>;
};
export function recordObject(directory: string, id: string, memo?: ReadMemo): unknown {
  const cached = memo?.json.get(id);
  if (cached !== undefined) return JSON.parse(cached);
  const physical = readSource(directory, `records/${id}`, Number.MAX_SAFE_INTEGER);
  const bytes = physical && unpackRecord(physical);
  invariant(
    bytes && digest(bytes) === id,
    code,
    'A retained Work record or index is missing or changed. Existing work is preserved.',
  );
  try {
    const text = bytes.toString('utf8'),
      value: unknown = JSON.parse(text);
    memo?.json.set(id, text);
    return value;
  } catch {
    invariant(false, code, 'A retained Work object is invalid.');
  }
}
export function pageHashes(directory: string, id: string, memo?: ReadMemo): string[] {
  const parsed = z
    .array(hash)
    .max(pageSize)
    .safeParse(recordObject(directory, id, memo));
  invariant(parsed.success, code, 'Work collection page is invalid.');
  return parsed.data;
}
function validateKeys(
  keys: string[],
  fields: Record<string, unknown>,
  arrays: Record<string, RecordCollection>,
) {
  invariant(
    new Set(keys).size === keys.length &&
      keys.length === Object.keys(fields).length + Object.keys(arrays).length &&
      keys.every(key => Object.hasOwn(fields, key) !== Object.hasOwn(arrays, key)),
    code,
    'Work record manifest keys are inconsistent.',
  );
  for (const index of Object.values(arrays))
    invariant(
      index.pages.length === Math.ceil(index.count / pageSize),
      code,
      'Work collection index is incomplete.',
    );
}
export function recordManifest(value: unknown): RecordManifest | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schema' in value) ||
    !['forge-work-records-v1', 'forge-work-records-v2', 'forge-work-records-v3'].includes(
      String(value.schema),
    )
  )
    return;
  const parsed = manifestSchema.safeParse(value);
  invariant(parsed.success, code, 'Work commit pointer is invalid.');
  const manifest = parsed.data;
  validateKeys(manifest.keys, manifest.fields, manifest.collections);
  return manifest;
}
export function readFragment(directory: string, id: string) {
  const parsed = fragmentSchema.safeParse(recordObject(directory, id));
  invariant(parsed.success, code, 'Work record fragment is invalid.');
  const value = parsed.data;
  validateKeys(value.keys, value.fields, value.arrays);
  return value;
}
export function readRecordValue(
  directory: string,
  id: string,
  fragmented: boolean,
  verify = false,
  memo?: ReadMemo,
): unknown {
  if (!fragmented) return recordObject(directory, id, memo);
  const raw = recordObject(directory, id, memo);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const parsed = fragmentSchema.safeParse(raw);
  invariant(parsed.success, code, 'Work record fragment is invalid.');
  const value = parsed.data;
  validateKeys(value.keys, value.fields, value.arrays);
  return Object.fromEntries(
    value.keys.map(key => [
      key,
      Object.hasOwn(value.arrays, key)
        ? readCollection(directory, value.arrays[key]!, 0, value.arrays[key]!.count, true, verify, memo)
            .records
        : value.fields[key],
    ]),
  );
}
export function readCollection(
  directory: string,
  index: RecordCollection,
  offset: number,
  limit: number,
  fragmented: boolean,
  verify = false,
  memo?: ReadMemo,
) {
  const memoKey = memo ? JSON.stringify([index, offset, limit, fragmented, verify]) : undefined;
  const retained = memoKey && memo?.collections.get(memoKey);
  if (retained)
    return {
      records: structuredClone(retained),
      total: index.count,
      offset,
      nextOffset: offset + retained.length < index.count ? offset + retained.length : null,
    };
  const records: unknown[] = [],
    end = Math.min(index.count, offset + limit);
  for (let position = offset; position < end;) {
    const page = Math.floor(position / pageSize),
      hashes = pageHashes(directory, index.pages[page]!, memo);
    invariant(
      hashes.length === Math.min(pageSize, index.count - page * pageSize),
      code,
      'Work collection page is incomplete.',
    );
    const stop = Math.min(end, (page + 1) * pageSize);
    while (position < stop) {
      records.push(readRecordValue(directory, hashes[position % pageSize]!, fragmented, verify, memo));
      position++;
    }
  }
  if (verify && index.lookup) validateIndex(recordIO(directory, false, memo), index.lookup, records);
  if (memoKey) memo!.collections.set(memoKey, records);
  return { records, total: index.count, offset, nextOffset: end < index.count ? end : null };
}
export function readRecordPage(
  directory: string,
  manifest: RecordManifest,
  collection: string,
  offset: number,
  limit: number,
) {
  invariant(Object.hasOwn(manifest.collections, collection), 'NOT_FOUND', 'Work collection does not exist.');
  return readCollection(
    directory,
    manifest.collections[collection]!,
    offset,
    limit,
    manifest.schema !== 'forge-work-records-v1',
  );
}
// Schema-16 legacy copies are large and immutable: page them as a one-record collection
// so ordinary commits never rewrite them inside the commit pointer.
const legacyKey = 'legacyIntentMerge';
function encodeStored(value: Record<string, unknown>) {
  const legacy = value[legacyKey];
  return [16, 18, 20, 22, 24].includes(value.schema as number) &&
    legacy &&
    typeof legacy === 'object' &&
    !Array.isArray(legacy)
    ? { ...value, [legacyKey]: [legacy] }
    : value;
}
function decodeStored(value: Record<string, unknown>) {
  const legacy = value[legacyKey];
  if ([16, 18, 20, 22, 24].includes(value.schema as number) && Array.isArray(legacy) && legacy.length === 1)
    value[legacyKey] = legacy[0];
  return value;
}
export function readRecords(directory: string, manifest: RecordManifest): Record<string, unknown> {
  return decodeStored(readRecordFields(directory, manifest));
}
function readRecordFields(directory: string, manifest: RecordManifest): Record<string, unknown> {
  const memo: ReadMemo = { json: new Map(), collections: new Map() };
  return Object.fromEntries(
    manifest.keys.map(key => [
      key,
      Object.hasOwn(manifest.collections, key)
        ? readCollection(
            directory,
            manifest.collections[key]!,
            0,
            manifest.collections[key]!.count,
            manifest.schema !== 'forge-work-records-v1',
            true,
            memo,
          ).records
        : manifest.fields[key],
    ]),
  );
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function recordIO(
  directory: string,
  create = true,
  memo?: ReadMemo,
  pending = false,
): IndexIO & { release(): void } {
  const records = join(directory, 'records');
  if (!existsSync(records) && create) mkdirSync(records, { mode: 0o700 });
  invariant(existsSync(records), code, 'Work records are unavailable.');
  invariant(
    lstatSync(records).isDirectory() && !lstatSync(records).isSymbolicLink(),
    code,
    'Work records must be a real directory.',
  );
  let release: (() => void) | undefined;
  const io = {
    release() {
      release?.();
      release = undefined;
    },
    read: (id: string) => recordObject(directory, id, memo),
    put(value: unknown): string {
      if (pending && !release) release = pendingRecordWriter(directory);
      const bytes = Buffer.from(JSON.stringify(value)),
        id = digest(bytes),
        path = join(records, id);
      if (existsSync(path)) {
        recordObject(directory, id);
        return id;
      }
      const temp = join(directory, `${randomUUID()}.tmp`),
        fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, packRecord(bytes));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temp, path);
      } catch (error) {
        unlinkSync(temp);
        throw error;
      }
      return id;
    },
  };
  return io;
}
export function putRecord(io: IndexIO, value: unknown, nestedArrays = true): string {
  value = jsonValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return io.put(value);
  const fields: Record<string, unknown> = Object.create(null),
    arrays: Record<string, RecordCollection> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (nestedArrays && Array.isArray(item)) arrays[key] = putCollection(io, item, true);
    else fields[key] = item;
  }
  return io.put({ kind: 'forge-work-record-v2', fields, keys: Object.keys(value), arrays });
}
export function putCollection(
  io: IndexIO,
  values: unknown[],
  indexed = true,
  nestedArrays = true,
): RecordCollection {
  const pages: string[] = [],
    entries = new Map<string, number[]>();
  for (let offset = 0; offset < values.length; offset += pageSize)
    pages.push(
      io.put(values.slice(offset, offset + pageSize).map(value => putRecord(io, value, nestedArrays))),
    );
  if (indexed)
    values.forEach((value, position) => {
      for (const key of recordKeys(value)) {
        const list = entries.get(key) ?? [];
        list.push(position);
        entries.set(key, list);
      }
    });
  return { count: values.length, pages, ...(indexed ? { lookup: indexBuild(io, entries) } : {}) };
}
/** Stage and flush immutable pages and the next pointer before writer admission.
 * Publication still requires the caller's expected-pointer CAS under its lock. */
export function prepareRecordPublication(directory: string, manifest: RecordManifest) {
  manifest.schema = 'forge-work-records-v3';
  syncDirectory(join(directory, 'records'));
  const temp = join(directory, `${randomUUID()}.tmp`),
    fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(manifest));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const expected = digest(JSON.stringify(manifest));
  const pending = preparePendingExchange(directory, manifest.fields.revision as number);
  return () => {
    invariant(
      digest(JSON.stringify(manifest)) === expected,
      'WORK_STALE',
      'Prepared Work pointer changed; prepare it again before publication.',
    );
    const bytes = readSource(directory, temp.slice(directory.length + 1), Number.MAX_SAFE_INTEGER);
    invariant(
      bytes && digest(bytes) === expected,
      'INVALID_WORK_STORE',
      'Prepared Work pointer bytes changed; the committed snapshot is preserved.',
    );
    pending();
    renameSync(temp, join(directory, 'work.json'));
    syncDirectory(directory);
    recordOwnerMutation(directory, manifest.fields.revision as number);
    stagedDetails.get(manifest)?.();
    stagedDetails.delete(manifest);
  };
}
export function publishRecords(directory: string, manifest: RecordManifest) {
  prepareRecordPublication(directory, manifest)();
}
/** Write content-addressed pages only; nothing is visible until `publishRecords` switches the pointer. */
export function stageRecords(directory: string, value: Record<string, unknown>): RecordManifest {
  value = jsonValue(value) as Record<string, unknown>;
  const putDetail = detailWriter(directory, true);
  let slim = Number(value.schema) >= 23;
  for (const key of value.nativeHead ? ['runs', 'automaticActions'] : []) {
    if (!Array.isArray(value[key])) continue;
    const before = value[key] as unknown[];
    const after = compactDetailPage(key, before, putDetail, detailReader(directory));
    if (after.some((record, index) => record !== before[index])) slim = true;
    value[key] = after;
  }
  if (slim) {
    value.schema = slimWorkFormat(Number(value.schema));
    value.workDetailsMigrated = true;
    const migration = value.workDetailMigration as { id?: string; fromSchema?: number } | undefined;
    if (migration?.id)
      value.workDetailMigrationReceipt = {
        id: migration.id,
        converter: 'work-details-v1',
        fromSchema: migration.fromSchema,
        revision: value.revision,
      };
    delete value.workDetailMigration;
  }
  value = encodeStored(value);
  const io = recordIO(directory),
    manifest: RecordManifest = {
      schema: 'forge-work-records-v3',
      fields: Object.create(null),
      keys: Object.keys(value),
      collections: Object.create(null),
    };
  for (const [key, field] of Object.entries(value)) {
    if (!Array.isArray(field)) manifest.fields[key] = field;
    // Originals are immutable as a whole: one ordinary fragment can retain their
    // arrays as fields. Existing v2 readers understand it without rehydrating or
    // indexing every historical child on each full load.
    else
      manifest.collections[key] = putCollection(
        io,
        field,
        true,
        !([16, 18, 20, 22, 24].includes(value.schema as number) && key === legacyKey),
      );
  }
  stagedDetails.set(manifest, putDetail.release);
  return manifest;
}
export function writeRecords(directory: string, value: Record<string, unknown>): void {
  publishRecords(directory, stageRecords(directory, value));
}
