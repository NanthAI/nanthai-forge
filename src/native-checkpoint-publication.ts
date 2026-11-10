// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { peersFileStamp } from './agent-peers-cache.js';
import { ForgeError, invariant } from './errors.js';
import { NativeSource } from './native-source.js';

/** A process-local retry signal; never a persisted record or user-visible error. */
export const checkpointPreparationChanged = Symbol('checkpoint preparation changed');

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

/** Object reads and writes are complete before taking the owner lock. A metadata
 * CAS detects collection, replacement, corruption and symlink changes to new
 * references without a second byte pass. Unchanged blobs are already retained
 * by the pinned parent. Unrelated insertions never invalidate this Lane. */
export function preparedCheckpointCurrent(
  source: NativeSource,
  candidate: { directory?: string; verified: ReadonlyMap<string, string> },
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
