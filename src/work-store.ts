import { wakeIntegrationPreview } from './integration-preview-wake.js';
import { wakeLandingWorker } from './landing-worker-wake.js';
import { captureTransactionFriction } from './friction-auto.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { indexPeerRecords } from './agent-peers-index.js';
// SPDX-License-Identifier: Apache-2.0
import { assertCurrentWorkFormat } from './work-format.js';
import { workLocked, workLockedAsync, type WorkLockOptions } from './work-lock.js';
import { mkdirBelow } from './mkdir-below.js';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { verifyRoot } from './git.js';
import {
  readWorkFile,
  readRecords,
  readRecordPage,
  recordManifest,
  stageRecords,
  publishRecords,
  type RecordManifest,
} from './work-records.js';
import { nativeOwner } from './native-source.js';
import { workGit } from './work-git.js';
import { recordKeys, lookupKey } from './work-record-index.js';
import {
  WorkRecordTransaction,
  type WorkCollection,
  type WorkRecord,
  type WorkRecordReadMemo,
} from './work-record-transaction.js';
import type { WorkData } from './work-types.js';
import { isUnifiedWork, parseWork } from './work-unified-types.js';
import { unifyIntent } from './work-intent-local.js';

import { preserveFields } from './work-normalization.js';
export { preserveFields } from './work-normalization.js';

import { createWork } from './work-create.js';

export class WorkStore {
  private writerDepth = 0;
  private readonly afterWriter: (() => void)[] = [];
  private afterPublication(run: () => void) {
    if (this.writerDepth) this.afterWriter.push(run);
    else run();
  }
  private readonly observation = new AsyncLocalStorage<{
    pointer: Buffer | null;
    selected?: WorkRecordTransaction | undefined;
    manifest?: RecordManifest | undefined;
    manifestRead?: boolean;
    reads?: WorkRecordReadMemo;
  }>();
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
  constructor(root: string, options: { readOnly?: boolean } = {}) {
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
    if (!existsSync(this.directory) && !options.readOnly) mkdirSync(this.directory, { mode: 0o700 });
    invariant(
      (options.readOnly && !existsSync(this.directory)) ||
        (lstatSync(this.directory).isDirectory() && !lstatSync(this.directory).isSymbolicLink()),
      'UNSAFE_WORK_STORE',
      'Work metadata must be a real directory.',
    );
    if (!options.readOnly) {
      wakeLandingWorker(this);
    }
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
      return createWork();
    }
    try {
      const original: unknown = JSON.parse(bytes.toString('utf8')),
        manifest = recordManifest(original);
      assertCurrentWorkFormat(manifest?.fields ?? original);
      const raw = (manifest ? readRecords(this.directory, manifest) : original) as Record<string, unknown>;
      return preserveFields(parseWork(raw), raw) as WorkData;
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'WORK_UPGRADE_REQUIRED') throw error;
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
    assertCurrentWorkFormat(manifest.fields);
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
      observation = this.observation.getStore();
    let manifest: RecordManifest | undefined;
    if (observation?.manifestRead) manifest = observation.manifest;
    else {
      manifest = bytes ? recordManifest(JSON.parse(bytes.toString('utf8'))) : undefined;
      if (observation) {
        observation.manifest = manifest;
        observation.manifestRead = true;
      }
    }
    if (
      !manifest ||
      manifest.schema === 'forge-work-records-v1' ||
      !Object.values(manifest.collections).every(index => index.lookup)
    )
      return;
    if (observation)
      observation.reads ??= { pages: new Map(), records: new Map(), json: new Map(), collections: new Map() };
    return new WorkRecordTransaction(
      this.directory,
      observation ? structuredClone(manifest) : manifest,
      bytes!,
      observation?.reads,
    );
  }

  select<K extends WorkCollection>(
    collection: K,
    value: string,
    field = 'id',
    compact = false,
  ): WorkRecord<K> | undefined {
    const observation = this.observation.getStore();
    const tx = observation ? (observation.selected ??= this.readRecords()) : this.readRecords();
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
      !manifest ||
      manifest.schema === 'forge-work-records-v1' ||
      Object.values(manifest.collections).some(index => !index.lookup)
    ) {
      this.save(this.load());
      bytes = this.readPointer()!;
      manifest = recordManifest(JSON.parse(bytes.toString('utf8')))!;
    }
    return new WorkRecordTransaction(this.directory, manifest, bytes!);
  }
  /** Prepare derived records and flush the next pointer before taking the writer lock. */
  prepareCommitRecords(transaction: WorkRecordTransaction, revision?: number) {
    captureTransactionFriction(transaction, this.readRecords());
    transaction.prepareCommit(revision);
  }
  commitRecords(
    transaction: WorkRecordTransaction,
    revision?: number,
    options: { prepared?: boolean; advisory?: boolean } = {},
  ) {
    const previous = this.readRecords();
    const prior = previous?.manifest.collections.lanes?.pages ?? [];
    if (!options.prepared) captureTransactionFriction(transaction, previous);
    const result = transaction.commit(revision);
    this.afterPublication(() => {
      if (options.advisory !== false) wakeIntegrationPreview(this, previous, transaction);

      wakeLandingWorker(this);
      try {
        if (options.advisory !== false)
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
    });
    return result;
  }
  /** Validate and stage immutable pages before writer admission. Caller pins collection until publication. */
  prepareSave(data: WorkData, stage = stageRecords): RecordManifest {
    assertCurrentWorkFormat(data);
    this.readPointer(); // Reject an old selected owner before staging any records.
    if (isUnifiedWork(data)) data.intents = data.intents.map(unifyIntent);
    parseWork(data);
    return stage(this.directory, data);
  }
  publishSave(manifest: RecordManifest, publish = () => publishRecords(this.directory, manifest)): void {
    const previous = this.readRecords();
    publish();
    const next = this.readRecords();
    this.afterPublication(() => {
      wakeIntegrationPreview(this, previous, next);

      wakeLandingWorker(this);
    });
  }
  save(data: WorkData): void {
    this.publishSave(this.prepareSave(data));
  }
  /** Advisory only: publication always acquires the owner lock and revalidates. */
  preparing() {
    return !existsSync(join(this.directory, 'lock'));
  }
  locked<T>(run: () => T, options: WorkLockOptions = {}): T {
    try {
      return workLocked(
        join(this.directory, 'lock'),
        () => {
          this.writerDepth++;
          try {
            return run();
          } finally {
            this.writerDepth--;
          }
        },
        options,
      );
    } finally {
      // Exact-page caches and wake hints finish before returning the receipt,
      // after writer release. Their immutable pins tolerate another publication.
      if (!this.writerDepth) for (const notify of this.afterWriter.splice(0)) notify();
    }
  }
  async lockedAsync<T>(run: () => T, options: WorkLockOptions = {}): Promise<T> {
    try {
      return await workLockedAsync(
        join(this.directory, 'lock'),
        () => {
          this.writerDepth++;
          try {
            return run();
          } finally {
            this.writerDepth--;
          }
        },
        options,
      );
    } finally {
      if (!this.writerDepth) for (const notify of this.afterWriter.splice(0)) notify();
    }
  }
  laneLocked<T>(laneId: string, run: () => T, options: WorkLockOptions = {}): T {
    invariant(/^[0-9a-f-]{36}$/i.test(laneId), 'BAD_ARGUMENT', 'Select a Lane UUID.');
    const directory = join(this.directory, 'lane-locks');
    mkdirBelow(this.directory, directory);
    return workLocked(join(directory, laneId), run, options);
  }
}
