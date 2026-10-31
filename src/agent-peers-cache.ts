// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';

/** Disposable local acceleration, never Work or source authority. Keys include exact
 * source identities; live entries additionally require fresh filesystem metadata. */
const SWEEP_EVERY_MS = 3_600_000;
const MAX_AGE_MS = 24 * 3_600_000;
export class PeersCache {
  private readonly directory: string;
  constructor(root: string, directory?: string) {
    this.directory = directory ?? join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`, digest(root));
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
  /** Every entry is a new file for a new source identity and nothing else removes them (1.1 GB, 44,000
   * files on one Mac). At most once an hour, drop entries not written for a day. */
  private sweep(now = Date.now()) {
    try {
      const stamp = join(this.directory, '.swept');
      try {
        if (now - lstatSync(stamp).mtimeMs < SWEEP_EVERY_MS) return;
      } catch {
        /* first sweep */
      }
      writeFileSync(stamp, '');
      utimesSync(stamp, now / 1000, now / 1000);
      for (const name of readdirSync(this.directory)) {
        if (name === '.swept') continue;
        const path = join(this.directory, name);
        if (now - lstatSync(path).mtimeMs > MAX_AGE_MS) rmSync(path, { force: true });
      }
    } catch {
      /* Disposable cache: a failed sweep only repeats. */
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
      this.sweep();
    } catch {
      // Cache availability never determines observation coverage.
    }
  }
}
export function peersFileStamp(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
}
