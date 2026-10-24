// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';

/** Disposable local acceleration, never Work or source authority. Keys include exact
 * source identities; live entries additionally require fresh filesystem metadata. */
export class PeersCache {
  private readonly directory: string;
  constructor(root: string) {
    this.directory = join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`, digest(root));
  }
  private validDirectory(path: string) {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid());
  }
  read<T>(key: string): T | undefined {
    try {
      if (!this.validDirectory(dirname(this.directory)) || !this.validDirectory(this.directory)) return;
      const path = join(this.directory, digest(key));
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      if (entry.key === key && entry.checksum === digest(JSON.stringify(entry.value)))
        return entry.value as T;
      return undefined;
    } catch {
      return undefined;
    }
  }
  write(key: string, value: unknown) {
    const path = join(this.directory, digest(key)),
      temporary = `${path}-${randomUUID()}`;
    try {
      mkdirSync(dirname(this.directory), { recursive: true, mode: 0o700 });
      if (!this.validDirectory(dirname(this.directory))) return;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!this.validDirectory(this.directory)) return;
      writeFileSync(temporary, JSON.stringify({ key, value, checksum: digest(JSON.stringify(value)) }), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, path);
    } catch {
      // Cache availability never determines observation coverage.
    }
  }
}
export function peersFileStamp(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
}
