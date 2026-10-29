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
export async function downloadSourcePack(pack: SourcePack & { url: string }, path: string, request = fetch) {
  invariant(pack.size <= sourcePackBytes, 'SOURCE_HASH_MISMATCH', 'Oversized pack.');
  const response = await request(pack.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
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
  const input = createReadStream(path);
  const stream = input.pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0),
    expanded = 0;
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
    const expected = [...state.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    invariant(
      header.version === 1 &&
        header.stateRef === pack.stateRef &&
        Array.isArray(header.files) &&
        header.files.length === expected.length &&
        pack.fileCount === expected.length,
      'SOURCE_HASH_MISMATCH',
      'Pack State differs.',
    );
    let total = 0;
    for (let i = 0; i < expected.length; i++) {
      const file = header.files[i],
        selected = expected[i]!;
      invariant(
        file.path === selected.path &&
          file.blob === selected.blob &&
          file.mode === selected.mode &&
          Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          file.size <= sourcePackFileBytes,
        'SOURCE_HASH_MISMATCH',
        'Pack inventory differs.',
      );
      total += file.size;
      invariant(total <= sourcePackTreeBytes, 'SOURCE_HASH_MISMATCH', 'Pack tree exceeds cache bound.');
    }
    await mkdir(cache, { recursive: true });
    for (const file of header.files) {
      const bytes = await take(file.size);
      invariant(digest(bytes) === file.blob, 'SOURCE_HASH_MISMATCH', 'Pack file differs.');
      await writeFile(join(cache, file.blob), bytes, { mode: 0o600 });
    }
    invariant(
      !pending.length && (await iterator.next()).done,
      'SOURCE_HASH_MISMATCH',
      'Trailing pack bytes.',
    );
  } finally {
    stream.destroy();
    input.destroy();
  }
}
