// SPDX-License-Identifier: Apache-2.0
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
export class WorkRecordTransaction {
  private readonly io;
  private readonly original: string;

  constructor(
    readonly directory: string,
    readonly manifest: RecordManifest,
    bytes: Buffer,
  ) {
    assertWorkFormat(manifest.fields);
    this.io = recordIO(directory, false);
    this.original = digest(bytes);
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
    const hashes = pageHashes(this.directory, index.pages[Math.floor(position / pageSize)]!);
    invariant(
      hashes.length === Math.min(pageSize, index.count - Math.floor(position / pageSize) * pageSize),
      'INVALID_WORK_STORE',
      'Work collection page is incomplete.',
    );
    return hashes[position % pageSize]!;
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
    return this.validate(collection, readRecordValue(this.directory, this.hash(collection, position), true));
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
  replace<K extends WorkCollection>(collection: K, position: number, value: WorkRecord<K>) {
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
  /** Schema 16 completes unified fields for Intents written by execution writers. */
  private unified<K extends WorkCollection>(collection: K, value: WorkRecord<K>) {
    return collection === 'intents' && isUnifiedWork(this.manifest.fields) ? unifyIntent(value) : value;
  }
  append<K extends WorkCollection>(collection: K, value: WorkRecord<K>) {
    const record = this.validate(collection, this.unified(collection, value)),
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
    return {
      position,
      record,
      counts: Object.fromEntries(Object.entries(header.arrays).map(([key, value]) => [key, value.count])),
    };
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
      const operation = (entry as { operation?: { id: string } })?.operation;
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
      ...lane.checkpoints.map(item => item.operation?.id),
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
    this.setSchema(candidate.manifest.fields.schema as WorkData['schema']);
    this.replace('lanes', this.positions('lanes', laneId)[0]!, {
      ...current,
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
  commit(revision = this.revision + 1) {
    assertWorkFormat(this.manifest.fields);
    invariant(
      Number.isSafeInteger(revision) && revision >= this.revision,
      'BAD_ARGUMENT',
      'Work revision is invalid.',
    );
    this.assertCurrent();
    this.manifest.fields.revision = revision;
    publishRecords(this.directory, this.manifest);
    return revision;
  }
}
