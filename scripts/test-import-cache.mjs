// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import ts from 'typescript';
import { parseImportFacts } from './test-import-facts.mjs';

// Bump when any parser, symbol, or fact semantics change. The TS version pins its AST semantics.
const schema = `3:${ts.version}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const maxBytes = 8 * 1024 * 1024;
const inputs = new WeakMap();

/** Associate an immutable inventory with verified source pins and optionally a private local cache. */
export function pinImportFacts(files, blobs, cacheDirectory) {
  inputs.set(files, { blobs, cacheDirectory, buckets: new Map(), current: new Map() });
}

// A fixed number of read batches, independent of file count. Only buckets
// with changed facts are replaced, and each retains one blob per path.
function bucketOf(path) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return (hash & 63).toString(16).padStart(2, '0');
}

function readCache(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > maxBytes) return new Map();
    const bytes = readFileSync(path);
    const body = bytes.subarray(32);
    if (!bytes.subarray(0, 32).equals(sha256(body))) return new Map();
    const cache = deserialize(body);
    if (cache.schema === schema && cache.entries instanceof Map) return cache.entries;
  } catch {
    // Missing, incompatible or interrupted cache reads are cold parses.
  }
  return new Map();
}

function writeCache(path, entries) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const body = serialize({ schema, entries });
    if (body.length + 32 > maxBytes) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, Buffer.concat([sha256(body), body]), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Cache I/O has no bearing on selection.
    }
  }
}

export function importFacts(files, withSymbols) {
  const input = inputs.get(files);
  const directory = input?.cacheDirectory;
  const current = input?.current ?? new Map();
  const changed = new Set();
  const complete = fact => fact && (!withSymbols || fact.invalid || fact.symbols);
  return {
    get(file) {
      const existing = current.get(file);
      if (complete(existing)) return existing;
      const hash = input?.blobs.get(file);
      const bucket = directory && validHash(hash) ? bucketOf(file) : undefined;
      if (bucket && !input.buckets.has(bucket)) input.buckets.set(bucket, readCache(join(directory, bucket)));
      const entries = bucket && input.buckets.get(bucket);
      const entry = entries?.get(file);
      if (entry && entry[0] === hash && complete(entry[1])) {
        current.set(file, entry[1]);
        return entry[1];
      }
      const fact = parseImportFacts(file, files.get(file) ?? '', withSymbols);
      current.set(file, fact);
      if (entries) {
        entries.set(file, [hash, fact]);
        changed.add(bucket);
      }
      return fact;
    },
    release(file) {
      if (!input || !validHash(input.blobs.get(file))) current.delete(file);
    },
    flush() {
      for (const bucket of changed) {
        const entries = input.buckets.get(bucket);
        for (const [file, [hash]] of entries)
          if (!files.has(file) || input.blobs.get(file) !== hash) entries.delete(file);
        writeCache(join(directory, bucket), entries);
      }
    },
  };
}
