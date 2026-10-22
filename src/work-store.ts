import { wakeLandingWorker } from './landing-worker-wake.js';
import { captureTransactionFriction } from './friction-auto.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { wakeAutoExchange } from './auto-exchange-wake.js';
import { indexPeerRecords } from './agent-peers-index.js';
// SPDX-License-Identifier: Apache-2.0
import { assertWorkFormat } from './work-format.js';
import { workLocked, type WorkLockOptions } from './work-lock.js';
import { mkdirBelow } from './mkdir-below.js';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { policyPreset } from './autonomy-policy.js';
import { join, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { verifyRoot } from './git.js';
import { readWorkFile, readRecords, readRecordPage, recordManifest, writeRecords } from './work-records.js';
import { nativeOwner } from './native-source.js';
import { workGit } from './work-git.js';
import { recordKeys, lookupKey } from './work-record-index.js';
import { WorkRecordTransaction, type WorkCollection, type WorkRecord } from './work-record-transaction.js';
import { workSchema, type WorkData } from './work-types.js';
import { isUnifiedWork, parseWork } from './work-unified-types.js';
import { unifyIntent } from './work-intent-local.js';

import { preserveFields } from './work-normalization.js';
export { preserveFields } from './work-normalization.js';

export class WorkStore {
  private readonly observation = new AsyncLocalStorage<{ pointer: Buffer | null }>();
  /** Atomic rename pins revision and immutable records together, without a writer lock. */
  observing<T>(run: () => T): T {
    if (this.observation.getStore()) return run();
    return this.observation.run({ pointer: readWorkFile(this.directory) }, run);
  }
  private readPointer() {
    const pinned = this.observation.getStore();
    return pinned ? pinned.pointer : readWorkFile(this.directory);
  }
  readonly root: string;
  readonly directory: string;
  readonly native: boolean;
  constructor(root: string) {
    const input = realpathSync(root),
      owner = nativeOwner(input);
    this.native = !!owner;
    this.root = owner ?? input;
    if (owner) this.directory = join(owner, '.forge', 'work');
    else {
      verifyRoot(this.root);
      const common = workGit(this.root, ['rev-parse', '--git-common-dir']).trim();
      this.directory = join(realpathSync(resolve(this.root, common)), 'forge-work');
    }
    if (!existsSync(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
    invariant(
      lstatSync(this.directory).isDirectory() && !lstatSync(this.directory).isSymbolicLink(),
      'UNSAFE_WORK_STORE',
      'Work metadata must be a real directory.',
    );
    wakeAutoExchange(this);
    wakeLandingWorker(this);
  }
  path(id: string): string {
    return join(this.directory, `lane-${id}`);
  }
  revision(): number {
    const bytes = this.readPointer();
    if (!bytes) return 0;
    try {
      const raw = JSON.parse(bytes.toString('utf8')),
        manifest = recordManifest(raw);
      if (!manifest) return this.load().revision;
      const revision = manifest.fields.revision;
      invariant(
        typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0,
        'INVALID_WORK_STORE',
        'Work revision is invalid.',
      );
      return revision;
    } catch {
      throw new ForgeError(
        'INVALID_WORK_STORE',
        'Work revision is unavailable. Existing Work remains preserved.',
      );
    }
  }
  load(): WorkData {
    return this.pinnedData(this.readPointer());
  }
  /** The atomically replaced small commit pointer pins one revision;
   * the immutable records it names stay readable after the lock is released. */
  pointer(): Buffer | null {
    return this.readPointer();
  }
  /** WorkData of a pinned pointer; equivalent to load() at the pinned revision. */
  pinnedData(bytes: Buffer | null): WorkData {
    if (!bytes) {
      invariant(
        this.observation.getStore()?.pointer === null || !existsSync(join(this.directory, 'work.json')),
        'INVALID_WORK_STORE',
        'Work metadata is unavailable. Existing work is preserved.',
      );
      return workSchema.parse({
        schema: 11,
        revision: 0,
        autonomyPolicy: policyPreset('supervised'),
        intents: [],
        lanes: [],
        views: [],
      });
    }
    try {
      const original: unknown = JSON.parse(bytes.toString('utf8')),
        manifest = recordManifest(original);
      const raw = (manifest ? readRecords(this.directory, manifest) : original) as Record<string, unknown>;
      return preserveFields(parseWork(raw), raw) as WorkData;
    } catch {
      throw new ForgeError(
        'INVALID_WORK_STORE',
        'Work metadata is invalid. Existing branches and workspaces are preserved.',
      );
    }
  }
  /** Complete portable WorkData; the on-disk commit pointer is not an archive. */
  snapshotBytes(): Buffer {
    return this.pinnedBytes(this.readPointer());
  }
  /** snapshotBytes() of a pinned pointer, read without holding the owner lock. */
  pinnedBytes(bytes: Buffer | null): Buffer {
    if (!bytes) return Buffer.from(JSON.stringify(this.pinnedData(bytes), null, 2));
    const raw: unknown = JSON.parse(bytes.toString('utf8')),
      manifest = recordManifest(raw);
    if (!manifest) {
      this.pinnedData(bytes);
      return bytes;
    }
    const data = readRecords(this.directory, manifest);
    parseWork(data);
    return Buffer.from(JSON.stringify(data, null, 2));
  }
  /** Reads only selected immutable record pages; no complete journal reconstruction. */
  page(collection: string, offset = 0, limit = 50) {
    invariant(
      Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0,
      'BAD_ARGUMENT',
      'Choose a nonnegative offset and positive page size.',
    );
    const bytes = this.readPointer(),
      raw: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : undefined;
    const manifest = recordManifest(raw);
    if (manifest)
      return {
        revision: manifest.fields.revision as number,
        ...readRecordPage(this.directory, manifest, collection, offset, limit),
      };
    const data = this.load(),
      records = (data as Record<string, unknown>)[collection];
    invariant(Array.isArray(records), 'NOT_FOUND', 'Work collection does not exist.');
    const end = Math.min(records.length, offset + limit);
    return {
      revision: data.revision,
      records: records.slice(offset, end),
      total: records.length,
      offset,
      nextOffset: end < records.length ? end : null,
    };
  }
  /** Read-only record access; legacy owners retain their full validation path. */
  readRecords(): WorkRecordTransaction | undefined {
    const bytes = this.readPointer(),
      manifest = bytes ? recordManifest(JSON.parse(bytes.toString('utf8'))) : undefined;
    return manifest?.schema === 'forge-work-records-v2' &&
      Object.values(manifest.collections).every(index => index.lookup)
      ? new WorkRecordTransaction(this.directory, manifest, bytes!)
      : undefined;
  }
  select<K extends WorkCollection>(
    collection: K,
    value: string,
    field = 'id',
    compact = false,
  ): WorkRecord<K> | undefined {
    const tx = this.readRecords();
    if (tx) {
      const position = tx.positions(collection, value, field)[0];
      return position === undefined
        ? undefined
        : compact
          ? tx.fieldsAt(collection, position).record
          : tx.at(collection, position);
    }
    return (this.load()[collection] as WorkRecord<K>[]).find(record =>
      recordKeys(record).includes(lookupKey(field, value)),
    );
  }
  /** Call under the existing owner lock; one validated migration prepares older owners. */
  records(): WorkRecordTransaction {
    let bytes = this.readPointer(),
      manifest = bytes ? recordManifest(JSON.parse(bytes.toString('utf8'))) : undefined;
    if (
      manifest?.schema !== 'forge-work-records-v2' ||
      Object.values(manifest.collections).some(index => !index.lookup)
    ) {
      this.save(this.load());
      bytes = this.readPointer()!;
      manifest = recordManifest(JSON.parse(bytes.toString('utf8')))!;
    }
    return new WorkRecordTransaction(this.directory, manifest, bytes!);
  }
  commitRecords(transaction: WorkRecordTransaction, revision?: number) {
    const previous = this.readRecords();
    const prior = previous?.manifest.collections.lanes?.pages ?? [];
    captureTransactionFriction(transaction, previous);
    const result = transaction.commit(revision);
    wakeAutoExchange(this);
    wakeLandingWorker(this);
    try {
      indexPeerRecords(
        this.root,
        transaction,
        (transaction.manifest.collections.lanes?.pages ?? []).flatMap((hash, page) =>
          hash !== prior[page] ? [page] : [],
        ),
      );
    } catch {
      /* Derived index cannot fail a committed mutation. */
    }
    return result;
  }
  save(data: WorkData): void {
    assertWorkFormat(data);
    const bytes = this.readPointer();
    let previousSchema: unknown;
    if (bytes) {
      try {
        const raw: unknown = JSON.parse(bytes.toString('utf8'));
        previousSchema = recordManifest(raw)?.fields.schema ?? (raw as { schema?: unknown })?.schema;
      } catch {
        throw new ForgeError(
          'INVALID_WORK_STORE',
          'Existing Work metadata is invalid and remains preserved.',
        );
      }
    }
    const lifecycle =
      data.intents.some(intent => intent.status === 'completed' || intent.lifecycle?.length) ||
      data.lanes.some(lane => lane.state === 'completed' || lane.lifecycle?.length);
    // Preserve versioned lifecycle and source anchors across older feature writers.
    const anchored = data.intents.some(intent => intent.notes.some(note => note.anchor));
    if (lifecycle || anchored || (typeof previousSchema === 'number' && previousSchema >= 8))
      data.schema = Math.max(
        data.schema,
        anchored ? 9 : lifecycle ? 8 : 1,
        typeof previousSchema === 'number' ? previousSchema : 1,
      ) as WorkData['schema'];
    if (
      data.lanes.some(
        lane => lane.pending?.actor || lane.pendingSync?.actor || lane.checkpoints.some(save => save.actor),
      )
    )
      data.schema = Math.max(data.schema, 12) as WorkData['schema'];
    if (isUnifiedWork(data)) data.intents = data.intents.map(unifyIntent);
    parseWork(data);
    writeRecords(this.directory, data);
    wakeAutoExchange(this);
    wakeLandingWorker(this);
  }
  /** Advisory only: publication always acquires the owner lock and revalidates. */
  preparing() {
    return !existsSync(join(this.directory, 'lock'));
  }
  locked<T>(run: () => T, options: WorkLockOptions = {}): T {
    return workLocked(join(this.directory, 'lock'), run, options);
  }
  laneLocked<T>(laneId: string, run: () => T, options: WorkLockOptions = {}): T {
    invariant(/^[0-9a-f-]{36}$/i.test(laneId), 'BAD_ARGUMENT', 'Select a Lane UUID.');
    const directory = join(this.directory, 'lane-locks');
    mkdirBelow(this.directory, directory);
    return workLocked(join(directory, laneId), run, options);
  }
}
