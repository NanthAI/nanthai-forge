// SPDX-License-Identifier: Apache-2.0
import { createReadStream, createWriteStream } from 'node:fs';
import { writeFile, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { digest } from './hash.js';
import type { NativeState, NativeFile } from './native-state-format.js';
import { invariant } from './errors.js';
import { sourcePackBytes, sourcePackTreeBytes, sourcePackFileBytes, type SourcePack } from './source-pack.js';

export async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
/** Deterministic gzip of a length-prefixed JSON inventory followed by exact file
 * bytes. No tar extensions, directories, links or archive-controlled writes.
 * Inventory is compared with a separately hash-verified State before extraction. */
export async function createSourcePack(stateRef: string, state: NativeState, cache: string, path: string) {
  const files: (NativeFile & { size: number })[] = [];
  let total = 0;
  for (const file of [...state.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const { size } = await stat(join(cache, file.blob));
    total += size;
    if (size > sourcePackFileBytes || total > sourcePackTreeBytes || files.length >= 100_000) return null;
    files.push({ ...file, size });
  }
  const header = Buffer.from(JSON.stringify({ version: 1, stateRef, files }));
  if (header.length > 16 * 1024 * 1024) return null;
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  async function* chunks() {
    yield prefix;
    yield header;
    for (const file of files) {
      invariant(
        (await fileDigest(join(cache, file.blob))) === file.blob,
        'SOURCE_HASH_MISMATCH',
        'Pack input changed.',
      );
      yield* createReadStream(join(cache, file.blob));
    }
  }
  let size = 0;
  try {
    await pipeline(
      Readable.from(chunks()),
      createGzip({ level: 1 }),
      new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          done(size > sourcePackBytes ? new Error('Pack cache bound exceeded.') : null, chunk);
        },
      }),
      createWriteStream(path, { mode: 0o600 }),
    );
    return { stateRef, sha256: await fileDigest(path), size, fileCount: files.length };
  } catch (error) {
    await rm(path, { force: true });
    if (size > sourcePackBytes) return null;
    throw error;
  }
}
/** Bounded by size and checksum; the deadline covers slow client links (default 10 min). */
export async function downloadSourcePack(
  pack: SourcePack & { url: string },
  path: string,
  request = fetch,
  timeoutMs = 600_000,
) {
  invariant(pack.size <= sourcePackBytes, 'SOURCE_HASH_MISMATCH', 'Oversized pack.');
  const response = await request(pack.url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'Pack unavailable.');
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body as never),
    new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        done(size > pack.size ? new Error('Oversized pack.') : null, chunk);
      },
    }),
    createWriteStream(path, { mode: 0o600 }),
  );
  invariant(
    size === pack.size && (await fileDigest(path)) === pack.sha256,
    'SOURCE_HASH_MISMATCH',
    'Pack checksum differs.',
  );
}
export async function unpackSourcePack(pack: SourcePack, state: NativeState, path: string, cache: string) {
  const expected = [...state.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  await readSourcePack(pack, path, cache, files => {
    invariant(files.length === expected.length, 'SOURCE_HASH_MISMATCH', 'Pack State differs.');
    for (let i = 0; i < expected.length; i++) {
      const file = files[i]!,
        selected = expected[i]!;
      invariant(
        file.path === selected.path && file.blob === selected.blob && file.mode === selected.mode,
        'SOURCE_HASH_MISMATCH',
        'Pack inventory differs.',
      );
    }
    return () => true;
  });
}
/** Client cache fill: every written object is checked against its own digest, so the
 * pack needs no State match; `keep` selects which verified objects are written. */
export async function unpackSourcePackObjects(
  pack: SourcePack,
  path: string,
  directory: string,
  keep: (blob: string) => boolean,
) {
  const written = new Set<string>();
  // Files with identical content share one blob: write and report it once.
  await readSourcePack(pack, path, directory, () => blob => {
    if (written.has(blob) || !keep(blob)) return false;
    written.add(blob);
    return true;
  });
  return [...written];
}
type PackFile = { path: string; blob: string; mode: string; size: number };
async function readSourcePack(
  pack: SourcePack,
  path: string,
  directory: string,
  inventory: (files: PackFile[]) => (blob: string) => boolean,
) {
  const input = createReadStream(path);
  const stream = input.pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0),
    expanded = 0,
    writing = 0;
  const writes = new Set<Promise<void>>();
  const take = async (length: number) => {
    const parts: Buffer[] = [];
    let left = length;
    while (left) {
      if (!pending.length) {
        const next = await iterator.next();
        invariant(!next.done, 'SOURCE_HASH_MISMATCH', 'Truncated pack.');
        pending = next.value as Buffer;
        expanded += pending.length;
        invariant(
          expanded <= sourcePackTreeBytes + 16 * 1024 * 1024 + 4,
          'SOURCE_HASH_MISMATCH',
          'Expanded pack exceeds cache bound.',
        );
      }
      const count = Math.min(left, pending.length);
      parts.push(pending.subarray(0, count));
      pending = pending.subarray(count);
      left -= count;
    }
    return Buffer.concat(parts, length);
  };
  try {
    const length = (await take(4)).readUInt32BE();
    invariant(length <= 16 * 1024 * 1024, 'SOURCE_HASH_MISMATCH', 'Pack header exceeds cache bound.');
    const header = JSON.parse((await take(length)).toString('utf8'));
    invariant(
      header.version === 1 &&
        header.stateRef === pack.stateRef &&
        Array.isArray(header.files) &&
        header.files.length === pack.fileCount,
      'SOURCE_HASH_MISMATCH',
      'Pack State differs.',
    );
    let total = 0;
    for (const file of header.files as PackFile[]) {
      invariant(
        typeof file?.path === 'string' &&
          typeof file.blob === 'string' &&
          /^[0-9a-f]{64}$/.test(file.blob) &&
          Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          file.size <= sourcePackFileBytes,
        'SOURCE_HASH_MISMATCH',
        'Pack inventory differs.',
      );
      total += file.size;
      invariant(total <= sourcePackTreeBytes, 'SOURCE_HASH_MISMATCH', 'Pack tree exceeds cache bound.');
    }
    const keep = inventory(header.files);
    await mkdir(directory, { recursive: true });
    for (const file of header.files as PackFile[]) {
      const bytes = await take(file.size);
      invariant(digest(bytes) === file.blob, 'SOURCE_HASH_MISMATCH', 'Pack file differs.');
      if (!keep(file.blob)) continue;
      // Bounded concurrent writes (16 files, 64 MiB): small-file latency dominates large trees.
      const write: Promise<void> = writeFile(join(directory, file.blob), bytes, { mode: 0o600 }).finally(
        () => {
          writes.delete(write);
          writing -= bytes.length;
        },
      );
      // Handled here and re-observed below, so a failure never becomes an unhandled rejection.
      write.catch(() => undefined);
      writes.add(write);
      writing += bytes.length;
      while (writes.size >= 16 || writing > 64 * 1024 * 1024) await Promise.race(writes);
    }
    await Promise.all(writes);
    invariant(
      !pending.length && (await iterator.next()).done,
      'SOURCE_HASH_MISMATCH',
      'Trailing pack bytes.',
    );
  } finally {
    await Promise.allSettled(writes);
    stream.destroy();
    input.destroy();
  }
}
