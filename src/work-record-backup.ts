// SPDX-License-Identifier: Apache-2.0
import { cpSync, existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import { readSource } from './files.js';
import { invariant } from './errors.js';
import { durableReplace, syncDirectory, syncFile } from './native-durability.js';
import { readWorkFile } from './work-records.js';
import type { WorkStore } from './work-store.js';

type Backup = {
  path: string;
  revision: number;
  pointer: string;
  at: string;
  files: { path: string; sha256: string; symlink?: boolean }[];
};
const registryName = 'record-collection-backups.json';
function backups(store: WorkStore): Backup[] {
  const bytes = readSource(store.directory, registryName, Number.MAX_SAFE_INTEGER);
  return bytes ? JSON.parse(bytes.toString()) : [];
}
/** Called under the owner lock. Copy the full directory, including unreferenced
 * pages, workspace files, source objects and pending operations, before deletion.
 * No recovery receipt is published until every copied file is flushed. */
export function backupRecordsOwner(store: WorkStore, revision: number): Backup {
  invariant(
    store.native,
    'UNSUPPORTED_NATIVE_WORK',
    'Full-directory record collection backups require a native owner.',
  );
  const path = join(dirname(store.root), `${basename(store.root)}.records-backup-${randomUUID()}`),
    temporary = `${path}.tmp`,
    files: Backup['files'] = [];
  cpSync(store.root, temporary, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  function flush(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name,
        file = join(directory, entry.name);
      if (entry.isDirectory()) flush(file, name);
      else if (entry.isSymbolicLink())
        files.push({ path: name, sha256: digest(readlinkSync(file)), symlink: true });
      else if (entry.isFile()) {
        syncFile(file);
        files.push({ path: name, sha256: digest(readFileSync(file)) });
      }
    }
    syncDirectory(directory);
  }
  flush(temporary);
  const pointer = digest(readWorkFile(store.directory)!);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
  const backup = { path, revision, pointer, at: new Date().toISOString(), files };
  durableReplace(join(store.directory, registryName), JSON.stringify([...backups(store), backup]));
  return backup;
}
export function verifiedRecordBackup(store: WorkStore, revision: number): Backup | undefined {
  const pointer = digest(readWorkFile(store.directory)!);
  return backups(store)
    .reverse()
    .find(backup => {
      if (backup.revision !== revision || backup.pointer !== pointer || !existsSync(backup.path))
        return false;
      try {
        const info = lstatSync(backup.path);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
        return backup.files.every(file => {
          if (file.symlink) {
            const path = join(backup.path, file.path);
            return lstatSync(path).isSymbolicLink() && digest(readlinkSync(path)) === file.sha256;
          }
          const bytes = readSource(backup.path, file.path, Number.MAX_SAFE_INTEGER);
          return !!bytes && digest(bytes) === file.sha256;
        });
      } catch {
        return false;
      }
    });
}
