import { readEditContext } from './agent-edit-context.js';
// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { peersFileStamp } from './agent-peers-cache.js';
import { ForgeError, invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { nativeCheckpointCandidate } from './native-checkpoint-candidate.js';
import { nativeChanges } from './native-diff.js';
import { assertMergeResolved } from './agent-sync.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { WorkStore } from './work-store.js';
import type { CheckpointAction } from './agent-workflow-schema.js';

/** A process-local retry signal; never a persisted record or user-visible error. */
export const checkpointPreparationChanged = Symbol('checkpoint preparation changed');
export const checkpointMetadataChanged = Symbol('checkpoint metadata changed');

// Identity is checked independently of timestamps: coarse clocks cannot prove
// that collection left a prepared object present.
function directoryIdentity(source: NativeSource) {
  try {
    const stat = lstatSync(source.directory, { bigint: true });
    invariant(
      stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(source.directory) === source.directory,
      'INVALID_NATIVE_SOURCE',
      'Native object storage is unavailable or redirected.',
    );
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('INVALID_NATIVE_SOURCE', 'Native object storage is unavailable or redirected.');
  }
}
function objectStamp(path: string) {
  try {
    return peersFileStamp(path);
  } catch {
    throw new ForgeError(
      'INVALID_NATIVE_SOURCE',
      'Native object is absent or changed; original work is retained.',
    );
  }
}
/** Verify bytes once while capturing; retain only identity/metadata stamps for
 * the final CAS. A new preparation always reads actual bytes again. */
class CheckpointSource extends NativeSource {
  readonly verified = new Map<string, string>();
  private retained = new Set<string>();
  override captureReport(...args: Parameters<NativeSource['captureReport']>) {
    const base = args[2];
    // These exact blobs are already reachable through the pinned Lane head.
    // Collection preserves them, and put() still reads/verifies their actual
    // bytes during capture. Only newly introduced references need a final CAS.
    if (base) this.retained = new Set(this.state(base).files.map(file => file.blob));
    return super.captureReport(...args);
  }
  override object(id: string) {
    if (this.retained.has(id)) return super.object(id);
    const path = join(this.directory, id),
      before = objectStamp(path);
    const bytes = super.object(id);
    invariant(before === objectStamp(path), 'SOURCE_CHANGED', 'Prepared source object changed.');
    this.verified.set(id, before);
    return bytes;
  }
  override put(bytes: Buffer) {
    const id = super.put(bytes);
    // Existing objects were verified through object(); freshly written objects
    // need their final identity pinned after the durable rename as well.
    if (!this.retained.has(id) && !this.verified.has(id)) this.object(id);
    return id;
  }
}
function prepareCandidate(store: WorkStore, command: CheckpointAction, preserveMerge: boolean) {
  if (!store.native) return;
  const source = new CheckpointSource(store.root),
    directory = directoryIdentity(source);
  const candidate = nativeCheckpointCandidate(
    store,
    { ...command, expectedTree: undefined },
    undefined,
    source,
  );
  if (!candidate) return;
  const lane = candidate.lane;
  invariant(
    !command.expectedTree || candidate.tree === command.expectedTree,
    'LANE_STALE',
    'Live source changed after review.',
  );
  if (lane.pendingMerge && !preserveMerge) assertMergeResolved(candidate.path, lane);
  const unchanged =
    !lane.pendingMerge && !nativeChanges(source.state(lane.head).files, candidate.capture.files);
  const head = unchanged
    ? lane.head
    : source.writeState(
        candidate.capture.files,
        lane.pendingMerge && !preserveMerge
          ? lane.pendingMerge.stack
            ? [lane.pendingMerge.parent, lane.head]
            : [lane.head, lane.pendingMerge.parent]
          : [lane.head],
        command.message,
        candidate.at,
        undefined,
        command.conversation ?? readEditContext(store.directory, lane.id),
      );
  return {
    ...candidate,
    head,
    unchanged,
    merge: JSON.stringify(lane.pendingMerge),
    verified: source.verified,
    directory: directoryIdentity(source) === directory ? directory : undefined,
  };
}
export function prepareCheckpoint(store: WorkStore, command: CheckpointAction, preserveMerge = false) {
  try {
    return { candidate: prepareCandidate(store, command, preserveMerge), error: undefined };
  } catch (error) {
    // Busy/operation/head checks still take precedence, but no failed preparation
    // falls back to scanning or writing source while holding the owner lock.
    return { candidate: undefined, error };
  }
}
export type PreparedCheckpoint = ReturnType<typeof prepareCandidate>;

/** Object reads and writes are complete before taking the owner lock. A metadata
 * CAS detects collection, replacement, corruption and symlink changes to new
 * references without a second byte pass. Unchanged blobs are already retained
 * by the pinned parent. Unrelated insertions never invalidate this Lane. */
export function preparedCheckpointCurrent(
  source: NativeSource,
  candidate: Pick<NonNullable<PreparedCheckpoint>, 'directory' | 'verified'>,
) {
  try {
    if (!candidate.directory || directoryIdentity(source) !== candidate.directory)
      throw checkpointPreparationChanged;
    for (const [id, stamp] of candidate.verified)
      if (peersFileStamp(join(source.directory, id)) !== stamp) throw checkpointPreparationChanged;
  } catch {
    throw checkpointPreparationChanged;
  }
}

/** Stage immutable Work pages from a read-only snapshot. The final commit checks
 * that exact manifest under the owner lock. Errors are deferred to the lock as
 * well, preserving busy/operation/head validation ordering. */
export function nativeCheckpointSelection<T>(
  store: WorkStore,
  select: (tx: WorkRecordTransaction) => T,
): T | undefined {
  let tx: WorkRecordTransaction | undefined;
  try {
    tx = store.readRecords();
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_CHANGED') throw checkpointMetadataChanged;
    return store.locked(
      () => {
        throw error;
      },
      { operation: 'checkpoint publication' },
    );
  }
  if (!tx) {
    store.locked(() => store.records(), { operation: 'checkpoint migration' });
    return;
  }
  try {
    return select(tx);
  } catch (error) {
    return store.locked(
      () => {
        try {
          tx.assertCurrent();
        } catch (changed) {
          if (changed instanceof ForgeError && changed.code === 'WORK_STALE') throw checkpointMetadataChanged;
          throw changed;
        }
        throw error;
      },
      { operation: 'checkpoint publication' },
    );
  }
}

/** Retain prepared sync bytes outside the owner lock. Collection races retry
 * this restoration, never the source merge or workspace application. */
export function prepareNativeObjects(source: NativeSource, objects: Map<string, Buffer>) {
  const directory = directoryIdentity(source),
    verified = new Map<string, string>();
  for (const [id, bytes] of objects) {
    invariant(source.put(bytes) === id, 'INVALID_NATIVE_SOURCE', 'Prepared source identity differs.');
    verified.set(id, objectStamp(join(source.directory, id)));
  }
  return { directory, verified };
}
