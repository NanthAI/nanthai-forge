// SPDX-License-Identifier: Apache-2.0
import { compactDetailPage, slimWorkFormat } from './work-record-details.js';
import { detailReader, detailWriter } from './work-detail-store.js';
import { assertWorkFormat } from './work-format.js';
import { isDeepStrictEqual } from 'node:util';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { indexGet, indexUpdate, lookupKey, recordKeys } from './work-record-index.js';
import {
  pageHashes,
  pageSize,
  jsonValue,
  putRecord,
  putCollection,
  readFragment,
  readRecordValue,
  recordIO,
  readWorkFile,
  publishRecords,
  prepareRecordPublication,
  type RecordManifest,
  type RecordCollection,
} from './work-records.js';
import type { WorkData } from './work-types.js';
import { isUnifiedWork, parseWork, safeParseWork } from './work-unified-types.js';
import { noteConversation, unifyIntent } from './work-intent-local.js';
import { preserveFields } from './work-normalization.js';
export type WorkCollection = {
  [K in keyof WorkData]-?: NonNullable<WorkData[K]> extends unknown[] ? K : never;
}[keyof WorkData];
export type WorkRecord<K extends WorkCollection> = NonNullable<WorkData[K]> extends (infer T)[] ? T : never;
export type WorkRecordReadMemo = {
  pages: Map<string, string[]>;
  records: Map<string, unknown>;
  json: Map<string, string>;
  collections: Map<string, unknown[]>;
};
// Keep compact provenance across ordinary object copies, without persisting it
// in JSON or treating these scheduling summaries as writable full records.
const compactRecords = new WeakSet<object>();
export const isCompactWorkRecord = (record: object) =>
  compactRecords.has(record) ||
  Object.values(record).some(value => Array.isArray(value) && compactRecords.has(value));

export class WorkRecordTransaction {
  private readonly io;
  private readonly putDetail;
  private readonly original: string;
  private readonly initial: string;
  private readonly pages: Map<string, string[]>;
  private readonly recordsByHash: Map<string, unknown>;
  private prepared?: { revision: number; publish: () => void };

  constructor(
    readonly directory: string,
    readonly manifest: RecordManifest,
    bytes: Buffer,
    memo?: WorkRecordReadMemo,
  ) {
    assertWorkFormat(manifest.fields);
    this.putDetail = detailWriter(directory, true);
    this.pages = memo?.pages ?? new Map();
    this.recordsByHash = memo?.records ?? new Map();
    this.io = recordIO(directory, false, memo ?? { json: new Map(), collections: new Map() }, true);
    this.original = digest(bytes);
    this.initial = JSON.stringify(manifest);
  }
  get revision() {
    return this.manifest.fields.revision as number;
  }
  data(): WorkData {
    return {
      ...parseWork({ ...this.manifest.fields, intents: [], lanes: [], views: [] }, true),
      ...this.manifest.fields,
    } as WorkData;
  }
  private index(collection: WorkCollection) {
    let index = this.manifest.collections[collection];
    if (!index) {
      index = putCollection(this.io, []);
      this.manifest.collections[collection] = index;
      this.manifest.keys.push(collection);
    }
    invariant(index?.lookup, 'INVALID_WORK_STORE', 'Work record lookup is unavailable.');
    return index;
  }
  positions(collection: WorkCollection, value: string, field = 'id') {
    if (!this.manifest.collections[collection]) return [];
    return indexGet(this.io, this.index(collection).lookup, lookupKey(field, value));
  }
  private hash(collection: WorkCollection, position: number) {
    const index = this.index(collection);
    invariant(
      Number.isSafeInteger(position) && position >= 0 && position < index.count,
      'INVALID_WORK_STORE',
      'Work lookup points outside its collection.',
    );
    const page = index.pages[Math.floor(position / pageSize)]!;
    let hashes = this.pages.get(page);
    if (!hashes) {
      hashes = pageHashes(this.directory, page);
      this.pages.set(page, hashes);
    }
    invariant(
      hashes.length === Math.min(pageSize, index.count - Math.floor(position / pageSize) * pageSize),
      'INVALID_WORK_STORE',
      'Work collection page is incomplete.',
    );
    return hashes[position % pageSize]!;
  }
  /** Immutable record identity without hydrating its histories. */
  versionAt(collection: WorkCollection, position: number) {
    return this.hash(collection, position);
  }
  private validate<K extends WorkCollection>(collection: K, raw: unknown): WorkRecord<K> {
    raw = jsonValue(raw);
    const result = safeParseWork(
      {
        ...this.manifest.fields,
        intents: [],
        lanes: [],
        views: [],
        [collection]: [raw],
      },
      true,
    );
    invariant(result.success, 'INVALID_WORK_STORE', 'Selected Work record is invalid.');
    const parsed = result.data;
    return preserveFields((parsed[collection] as unknown[])[0], raw) as WorkRecord<K>;
  }
  at<K extends WorkCollection>(collection: K, position: number): WorkRecord<K> {
    const hash = this.hash(collection, position),
      key = `${this.manifest.fields.schema}:${collection}:${hash}`;
    let record = this.recordsByHash.get(key);
    if (record === undefined) {
      record = this.validate(collection, readRecordValue(this.directory, hash, true));
      this.recordsByHash.set(key, record);
    }
    // Callers edit their selected copy; immutable read memos never carry edits
    // across selections or transactions.
    return structuredClone(record) as WorkRecord<K>;
  }
  find<K extends WorkCollection>(
    collection: K,
    value: string,
    field = 'id',
    last = false,
  ): { position: number; record: WorkRecord<K> } | undefined {
    const positions = this.positions(collection, value, field),
      position = last ? positions.at(-1) : positions[0];
    if (position === undefined) return;
    const record = this.at(collection, position);
    invariant(
      recordKeys(record).includes(lookupKey(field, value)),
      'INVALID_WORK_STORE',
      'Work record lookup differs from its retained record.',
    );
    return { position, record };
  }
  all<K extends WorkCollection>(collection: K, value: string, field: string): WorkRecord<K>[] {
    return this.positions(collection, value, field).map(position => {
      const record = this.at(collection, position);
      invariant(
        recordKeys(record).includes(lookupKey(field, value)),
        'INVALID_WORK_STORE',
        'Work record lookup differs from its retained record.',
      );
      return record;
    });
  }
  private setHash(index: RecordCollection, position: number, hash: string) {
    const page = Math.floor(position / pageSize),
      hashes = index.pages[page] ? pageHashes(this.directory, index.pages[page]!) : [];
    invariant(
      position <= index.count && position % pageSize <= hashes.length,
      'INVALID_WORK_STORE',
      'Work record append position is invalid.',
    );
    hashes[position % pageSize] = hash;
    index.pages[page] = this.io.put(hashes);
    if (position === index.count) index.count++;
  }
  private keys(index: RecordCollection, position: number, before: string[], after: string[]) {
    const changes = new Map<string, number[]>();
    for (const key of before.filter(key => !after.includes(key)))
      changes.set(
        key,
        indexGet(this.io, index.lookup, key).filter(value => value !== position),
      );
    for (const key of after.filter(key => !before.includes(key)))
      changes.set(
        key,
        [...indexGet(this.io, index.lookup, key), position].sort((a, b) => a - b),
      );
    if (changes.size) index.lookup = indexUpdate(this.io, index.lookup, changes);
  }
  private compact<K extends WorkCollection>(collection: K, value: WorkRecord<K>): WorkRecord<K> {
    if (!this.manifest.fields.nativeHead) return value;
    const next = compactDetailPage(
      collection,
      [value],
      this.putDetail,
      detailReader(this.directory),
    )[0] as WorkRecord<K>;
    if (next !== value)
      this.setSchema(slimWorkFormat(Number(this.manifest.fields.schema)) as WorkData['schema']);
    return next;
  }
  replace<K extends WorkCollection>(collection: K, position: number, value: WorkRecord<K>) {
    value = this.compact(collection, value);
    const before = this.at(collection, position),
      parsed = parseWork(
        { ...this.manifest.fields, intents: [], lanes: [], views: [], [collection]: [before] },
        true,
      );
    value = this.unified(collection, value);
    const known = (parsed[collection] as Record<string, unknown>[])[0]!;
    const extensions = Object.fromEntries(
      Object.entries(before as Record<string, unknown>).filter(([key]) => !Object.hasOwn(known, key)),
    );
    const record = this.validate(collection, { ...extensions, ...(value as object) }),
      index = this.index(collection);
    if (isDeepStrictEqual(before, record)) return record;
    const header = readFragment(this.directory, this.hash(collection, position)),
      fields: Record<string, unknown> = Object.create(null),
      arrays: Record<string, RecordCollection> = Object.create(null);
    for (const [key, next] of Object.entries(record as object)) {
      if (!Array.isArray(next)) {
        fields[key] = next;
        continue;
      }
      const previous = (before as Record<string, unknown>)[key];
      if (
        Array.isArray(previous) &&
        next.length >= previous.length &&
        previous.every((item, i) => JSON.stringify(item) === JSON.stringify(next[i]))
      ) {
        const retained = header.arrays[key]!;
        arrays[key] = { ...retained, pages: [...retained.pages] };
        for (const item of next.slice(previous.length)) {
          const position = arrays[key]!.count;
          this.keys(arrays[key]!, position, [], recordKeys(item));
          this.setHash(arrays[key]!, position, putRecord(this.io, item));
        }
      } else arrays[key] = putCollection(this.io, next, true);
    }
    this.keys(index, position, recordKeys(before), recordKeys(record));
    this.setHash(
      index,
      position,
      this.io.put({ kind: 'forge-work-record-v2', fields, keys: Object.keys(record as object), arrays }),
    );
    return record;
  }
  /** Representation-only migration: selectors/positions stay exact. Publish
   * each changed physical page once, without retaining 128 intermediate copies. */
  replacePage<K extends WorkCollection>(collection: K, offset: number, values: WorkRecord<K>[]) {
    const index = this.index(collection),
      pages = new Map<number, string[]>();
    invariant(
      offset >= 0 && offset + values.length <= index.count,
      'BAD_ARGUMENT',
      'Migration page exceeds its retained collection.',
    );
    values.forEach((value, entry) => {
      const position = offset + entry,
        before = this.at(collection, position),
        next = this.validate(collection, this.compact(collection, value));
      invariant(
        isDeepStrictEqual(recordKeys(before), recordKeys(next)),
        'INVALID_WORK_STORE',
        'A representation migration cannot change record selectors.',
      );
      if (isDeepStrictEqual(before, next)) return;
      const page = Math.floor(position / pageSize);
      const hashes = pages.get(page) ?? pageHashes(this.directory, index.pages[page]!);
      hashes[position % pageSize] = putRecord(this.io, next);
      pages.set(page, hashes);
    });
    for (const [page, hashes] of pages) index.pages[page] = this.io.put(hashes);
  }
  /** Schema 16 completes unified fields for Intents written by execution writers. */
  private unified<K extends WorkCollection>(collection: K, value: WorkRecord<K>) {
    return collection === 'intents' && isUnifiedWork(this.manifest.fields) ? unifyIntent(value) : value;
  }
  append<K extends WorkCollection>(collection: K, value: WorkRecord<K>) {
    const record = this.validate(collection, this.compact(collection, this.unified(collection, value))),
      index = this.index(collection),
      position = index.count;
    this.keys(index, position, [], recordKeys(record));
    this.setHash(index, position, putRecord(this.io, record));
    return record;
  }
  fields<K extends WorkCollection>(collection: K, id: string) {
    const position = this.positions(collection, id)[0];
    if (position === undefined) return;
    const found = this.fieldsAt(collection, position);
    invariant(
      (found.record as { id?: string }).id === id,
      'INVALID_WORK_STORE',
      'Selected Work record identity differs.',
    );
    return found;
  }
  fieldsAt<K extends WorkCollection>(collection: K, position: number) {
    const header = readFragment(this.directory, this.hash(collection, position));
    const record = this.validate(
      collection,
      Object.fromEntries(
        header.keys.map(key => [key, Object.hasOwn(header.arrays, key) ? [] : header.fields[key]]),
      ),
    );
    compactRecords.add(record as object);
    for (const value of Object.values(record as object)) if (Array.isArray(value)) compactRecords.add(value);
    return {
      position,
      record,
      counts: Object.fromEntries(Object.entries(header.arrays).map(([key, value]) => [key, value.count])),
    };
  }
  /** Read one retained array entry without hydrating the rest of its record. */
  fieldAt(collection: WorkCollection, position: number, field: string, entry: number): unknown {
    invariant(Number.isSafeInteger(entry) && entry >= 0, 'BAD_ARGUMENT', 'Invalid history position.');
    const header = readFragment(this.directory, this.hash(collection, position)),
      array = header.arrays[field];
    if (!array || entry >= array.count) return;
    const hashes = pageHashes(this.directory, array.pages[Math.floor(entry / pageSize)]!);
    return readRecordValue(this.directory, hashes[entry % pageSize]!, true);
  }
  fieldFind(collection: WorkCollection, id: string, field: string, value: string, key = 'id') {
    const position = this.positions(collection, id)[0];
    if (position === undefined) return;
    const header = readFragment(this.directory, this.hash(collection, position)),
      array = header.arrays[field];
    invariant(array?.lookup, 'INVALID_WORK_STORE', 'Selected history lookup is unavailable.');
    const found = indexGet(this.io, array.lookup, lookupKey(key, value))[0];
    if (found === undefined) return;
    const hashes = pageHashes(this.directory, array.pages[Math.floor(found / pageSize)]!);
    const record = readRecordValue(this.directory, hashes[found % pageSize]!, true);
    invariant(
      recordKeys(record).includes(lookupKey(key, value)),
      'INVALID_WORK_STORE',
      'Selected history lookup differs from its record.',
    );
    return record;
  }
  patchFields(collection: WorkCollection, id: string, fields: Record<string, unknown>) {
    if (
      (collection === 'runs' && ['checkSelection', 'backend'].some(key => Object.hasOwn(fields, key))) ||
      (collection === 'automaticActions' && Object.hasOwn(fields, 'result'))
    ) {
      const found = this.find(collection, id);
      invariant(found, 'NOT_FOUND', 'Work record not found.');
      this.replace(collection, found.position, { ...found.record, ...fields } as typeof found.record);
      return found.position;
    }
    const position = this.positions(collection, id)[0];
    invariant(position !== undefined, 'NOT_FOUND', 'Work record not found.');
    const header = readFragment(this.directory, this.hash(collection, position)),
      before = { ...header.fields };
    invariant(header.fields.id === id, 'INVALID_WORK_STORE', 'Selected Work record identity differs.');
    for (const [key, value] of Object.entries(fields)) {
      invariant(
        !Array.isArray(value) && !Object.hasOwn(header.arrays, key),
        'BAD_ARGUMENT',
        'Use history append for array fields.',
      );
      if (value === undefined) {
        delete header.fields[key];
        header.keys = header.keys.filter(item => item !== key);
      } else {
        header.fields[key] = value;
        if (!header.keys.includes(key)) header.keys.push(key);
      }
    }
    this.validate(
      collection,
      Object.fromEntries(
        header.keys.map(key => [key, Object.hasOwn(header.arrays, key) ? [] : header.fields[key]]),
      ),
    );
    if (isDeepStrictEqual(jsonValue(before), jsonValue(header.fields))) return position;
    this.keys(this.index(collection), position, recordKeys(before), recordKeys(header.fields));
    this.setHash(this.index(collection), position, this.io.put(header));
    return position;
  }
  /** Append a selected history entry without reading, hashing or rewriting preceding entries. */
  appendField<K extends WorkCollection>(collection: K, id: string, field: string, entry: unknown) {
    const position = this.positions(collection, id)[0];
    invariant(
      position !== undefined,
      'NOT_FOUND',
      `${collection === 'intents' ? 'Intent' : 'Lane'} not found.`,
    );
    const header = readFragment(this.directory, this.hash(collection, position));
    invariant(
      header && typeof header === 'object' && !Array.isArray(header) && header.fields.id === id,
      'INVALID_WORK_STORE',
      'Selected Work record identity differs.',
    );
    let array = header.arrays[field];
    if (!array) {
      invariant(field === 'lifecycle', 'INVALID_WORK_STORE', 'Selected history is unavailable.');
      array = putCollection(this.io, [], true);
      header.arrays[field] = array;
      header.keys.push(field);
    }
    const raw = Object.fromEntries(
      header.keys.map(key => [
        key,
        Object.hasOwn(header.arrays, key) ? (key === field ? [entry] : []) : header.fields[key],
      ]),
    );
    this.validate(collection, raw); // Validate header and new entry with original schemas; old entries retain their original immutable validation.
    const next = array.count;
    this.keys(array, next, [], recordKeys(entry));
    this.setHash(array, next, putRecord(this.io, entry));
    if (collection === 'intents' && field === 'notes' && isUnifiedWork(this.manifest.fields)) {
      // Every schema-16 note has a stable conversation identity.
      const conversation = header.arrays.conversation;
      invariant(conversation, 'INVALID_WORK_STORE', 'Intent conversation is unavailable.');
      const entry = noteConversation(id, next);
      this.keys(conversation, conversation.count, [], recordKeys(entry));
      this.setHash(conversation, conversation.count, putRecord(this.io, entry));
    }
    if (field === 'checkpoints') {
      const checkpoint = entry as { operation?: { id: string }; sync?: { operation?: { id: string } } };
      for (const operation of [checkpoint.operation, checkpoint.sync?.operation])
        if (operation)
          this.keys(this.index(collection), position, [], [lookupKey('agentOperation', operation.id)]);
    }
    this.setHash(this.index(collection), position, this.io.put(header));
    return position;
  }
  version(collection: WorkCollection, id: string) {
    const position = this.positions(collection, id)[0];
    return position === undefined ? undefined : this.hash(collection, position);
  }
  /** Stage Lane source fields while preserving concurrent metadata writers. */
  stageLane(candidate: WorkRecordTransaction, laneId: string, expectedVersion: string) {
    const before = this.validate('lanes', readRecordValue(this.directory, expectedVersion, true)),
      current = this.find('lanes', laneId)?.record,
      lane = candidate.find('lanes', laneId)!.record;
    const sourceFields = [
      'id',
      'intentId',
      'base',
      'stack',
      'head',
      'pending',
      'pendingMerge',
      'pendingSync',
      'pendingUndo',
      'checkpoints',
    ] as const;
    invariant(
      current && sourceFields.every(key => isDeepStrictEqual(current[key], before[key])),
      'LANE_STALE',
      'Lane source changed; original source remains available.',
    );
    const operations = [
      ...lane.checkpoints.flatMap(item => [item.operation?.id, item.sync?.operation?.id]),
      lane.pending?.operation?.id,
      lane.pendingSync?.operation?.id,
      lane.pendingMerge?.operation.id,
      lane.pendingUndo?.operation.id,
    ].filter((id): id is string => !!id);
    for (const operation of new Set(operations)) {
      const owners = this.positions('lanes', operation, 'agentOperation');
      invariant(
        !this.positions('intents', operation, 'agentOperation').length &&
          owners.every(position => position === this.positions('lanes', laneId)[0]),
        'WORK_OPERATION_CHANGED',
        'This operation belongs to another retained action.',
      );
    }
    const changedAfter = !isDeepStrictEqual(lane.after, before.after);
    invariant(
      !changedAfter || isDeepStrictEqual(current.after, before.after),
      'LANE_STALE',
      'Lane landing dependency changed; retry from its current source.',
    );
    this.setSchema(candidate.manifest.fields.schema as WorkData['schema']);
    this.replace('lanes', this.positions('lanes', laneId)[0]!, {
      ...current,
      base: lane.base,
      stack: lane.stack,
      ...(changedAfter ? { after: lane.after } : {}),
      head: lane.head,
      pendingMerge: lane.pendingMerge,
      pending: lane.pending,
      pendingSync: lane.pendingSync,
      pendingUndo: lane.pendingUndo,
      checkpoints: lane.checkpoints,
    });
  }
  setSchema(schema: WorkData['schema']) {
    this.manifest.fields.schema = Math.max(this.manifest.fields.schema as number, schema);
  }
  /** Call under the owner lock before publishing an optimistic preparation. */
  assertCurrent() {
    const bytes = readWorkFile(this.directory);
    invariant(
      bytes && digest(bytes) === this.original,
      'WORK_STALE',
      'Work changed. Refresh before retrying; nothing was overwritten.',
    );
  }
  dispose() {
    this.io.release();
    this.putDetail.release();
  }
  /** Call after staging mutations, outside the owner lock. The final commit
   * still verifies the original pointer before publishing these durable bytes. */
  prepareCommit(revision?: number) {
    if (revision === undefined && JSON.stringify(this.manifest) === this.initial) return;
    const next = revision ?? this.revision + 1;
    invariant(
      Number.isSafeInteger(next) && next >= this.revision,
      'BAD_ARGUMENT',
      'Work revision is invalid.',
    );
    assertWorkFormat(this.manifest.fields);
    this.manifest.fields.revision = next;
    this.prepared = { revision: next, publish: prepareRecordPublication(this.directory, this.manifest) };
  }
  commit(revision?: number) {
    try {
      return this.publish(revision);
    } finally {
      this.dispose();
    }
  }
  private publish(revision?: number) {
    const nextRevision = revision ?? this.prepared?.revision ?? this.revision + 1;
    assertWorkFormat(this.manifest.fields);
    invariant(
      Number.isSafeInteger(nextRevision) && nextRevision >= this.revision,
      'BAD_ARGUMENT',
      'Work revision is invalid.',
    );
    invariant(
      !this.prepared || this.prepared.revision === nextRevision,
      'BAD_ARGUMENT',
      'Use the prepared Work revision.',
    );
    this.assertCurrent();
    if (revision === undefined && JSON.stringify(this.manifest) === this.initial) return this.revision;
    this.manifest.fields.revision = nextRevision;
    if (this.prepared) this.prepared.publish();
    else publishRecords(this.directory, this.manifest);
    return nextRevision;
  }
}
