// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readSource } from './files.js';
import { NativeSource } from './native-source.js';
import { receiptSchema } from './work-run-receipt.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';
/** Validate and flush retained evidence before authorizing removal of its disposable copy. */
export function checkCleanupBlocker(store: WorkStore, run: CheckRun, directory: string) {
  if (run.error?.code === 'DISK_LOW')
    return 'DISK_LOW refused execution; existing workspace and runtime files are retained.';
  try {
    const bytes = readSource(directory, 'result.json', 4 * 1024 * 1024);
    if (!bytes) return 'Terminal receipt is unavailable; workspace retained.';
    const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (receipt.status !== run.status || receipt.endedAt !== run.endedAt)
      return 'Terminal receipt does not match the recorded run.';
    if (
      (run.check.artifactPaths?.length ?? 0) !== (receipt.artifacts?.length ?? 0) ||
      receipt.artifacts?.some(item => item.status !== 'retained')
    )
      return 'Selected output capture is incomplete.';
    const flush = (path: string, artifact?: { size: number; sha256: string }) => {
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe evidence file');
        if (artifact) {
          const hash = createHash('sha256'),
            buffer = Buffer.alloc(1024 * 1024);
          let length: number;
          while ((length = readSync(fd, buffer, 0, buffer.length, null)))
            hash.update(buffer.subarray(0, length));
          if (info.size !== artifact.size || hash.digest('hex') !== artifact.sha256)
            throw new Error('Artifact changed');
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    if (receipt.artifacts?.length) {
      const folder = join(directory, 'artifacts');
      if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder)
        return 'Retained artifact directory changed.';
      const fd = openSync(folder, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    for (const item of receipt.artifacts ?? []) {
      if (item.status === 'retained') flush(join(directory, 'artifacts', item.filename), item);
    }
    for (const leaf of ['stdout.log', 'stderr.log', 'result.json']) flush(join(directory, leaf));
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const source = new NativeSource(store.root),
      workspace = join(directory, 'workspace');
    for (const file of source.state(run.head).files) source.object(file.blob);
    // A missing workspace can still leave a private runtime directory to reclaim.
    try {
      if (!existsSync(workspace)) return undefined;
      if (!lstatSync(workspace).isDirectory() || realpathSync(workspace) !== workspace)
        return 'Workspace is not a plain directory.';
      if (
        source.tree(source.capture(workspace, false, run.head)) !== source.tree(source.state(run.head).files)
      )
        return 'Source differs from the run State; uncaptured edits retained.';
    } catch {
      return 'Workspace source coverage is unavailable.';
    }
    return undefined;
  } catch {
    return 'Retained receipt, logs or artifacts could not be validated and flushed.';
  }
}
