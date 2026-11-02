// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  opendirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { durableReplace } from './native-durability.js';
import { randomUUID } from 'node:crypto';
import { invariant } from './errors.js';

export const cacheUsePath = (copy: string) => join(`${copy}.forge-client`, 'cache-use.json');
const legacyPath = (copy: string) => join(copy, '.forge', 'cache-use.json');
type CacheUse = { bytes: number | undefined; used: number };

/** Accept only the record written by earlier clients, never arbitrary metadata or links. */
function readUse(path: string): CacheUse | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256) return null;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'bytes')) return null;
    if (
      'bytes' in record &&
      (typeof record.bytes !== 'number' || !Number.isFinite(record.bytes) || record.bytes < 0)
    )
      return null;
    return { bytes: record.bytes as number | undefined, used: stat.mtimeMs };
  } catch {
    return null;
  }
}
export function isNestedLaneCopy(copy: string) {
  copy = resolve(copy);
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(basename(copy)) &&
    basename(dirname(copy)) === 'lanes' &&
    basename(dirname(dirname(copy))).endsWith('.forge-client')
  );
}
export function readCacheUse(copy: string): CacheUse | null {
  return readUse(cacheUsePath(copy)) ?? readUse(legacyPath(copy));
}
export function writeCacheUse(copy: string, record: CacheUse, durable = false) {
  const file = cacheUsePath(copy),
    directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH', 'Cache directory must be real.');
  const bytes = JSON.stringify(record.bytes === undefined ? {} : { bytes: record.bytes });
  if (durable) durableReplace(file, bytes);
  else {
    // Advisory touches/inventory need atomic visibility, without per-copy durability barriers.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  utimesSync(file, record.used / 1000, record.used / 1000);
}
/** A marked checkout may retain this exact legacy record until replacement.
 * Persist it beside the copy first; leave the original and all unknown metadata alone. */
export function preserveLegacyCacheUse(copy: string): boolean {
  const legacy = readUse(legacyPath(copy));
  if (!legacy) return false;
  const current = readUse(cacheUsePath(copy));
  writeCacheUse(
    copy,
    {
      bytes: current?.bytes ?? legacy.bytes,
      used: Math.max(current?.used ?? 0, legacy.used),
    },
    true,
  );
  return true;
}

/** The source dirty check excludes .forge; GC must also preserve unknown metadata. */
export function unknownCacheMetadata(copy: string): boolean {
  const directory = join(copy, '.forge');
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    const entries = opendirSync(directory);
    try {
      // Only two names are known. Stop at the first other entry, so even an
      // arbitrarily large unknown metadata directory costs at most three reads.
      for (;;) {
        const entry = entries.readSync();
        if (!entry) return false;
        if (
          entry.name !== 'hosted-lane.json' &&
          (entry.name !== 'cache-use.json' || !readUse(legacyPath(copy)))
        )
          return true;
      }
    } finally {
      entries.closeSync();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
