// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { fetchGitPack, PackLimitError } from './git-upload-pack.js';
import type { GithubSourceEntry } from './github-project-source.js';
import { ForgeError, invariant } from './errors.js';

/** A large blob is its own byte page. Asking for exactly one object, without
 * thin-pack, yields a whole blob: no delta base or whole-file buffer is needed.
 * The sink may stage immutable chunks; it binds them only after this verifies. */
export async function streamGithubBlobPack(
  repository: string,
  entry: GithubSourceEntry,
  consume: (part: Buffer) => Promise<void>,
  token?: string,
  request?: typeof fetch,
) {
  const stream = new DecompressionStream('deflate'),
    writer = stream.writable.getWriter(),
    reader = stream.readable.getReader(),
    git = createHash('sha1').update(`blob ${entry.size}\0`),
    logical = createHash('sha256');
  let size = 0,
    header = Buffer.alloc(0),
    tail = Buffer.alloc(0),
    started = false;
  const read = (async () => {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        invariant(size <= entry.size, 'ARTIFACT_INTEGRITY', 'GitHub blob exceeds its pinned size.');
        git.update(part.value);
        logical.update(part.value);
        await consume(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  })();
  // A failed consumer cancels the decompressor; its pending write then rejects.
  void read.catch(() => {});
  try {
    await fetchGitPack(
      {
        url: `https://github.com/${repository}`,
        want: entry.sha,
        ...(token ? { token } : {}),
        ...(request ? { fetch: request } : {}),
        totalTimeoutMs: 120_000,
        limitBytes: entry.size + Math.ceil(entry.size / 1000) + 1056,
      },
      async part => {
        if (!started) {
          header = Buffer.concat([header, part]);
          if (header.length < 13) return;
          invariant(
            header.readUInt32BE(8) === 1 && ((header[12]! >> 4) & 7) === 3,
            'ARTIFACT_INTEGRITY',
            'GitHub returned another object in the blob pack.',
          );
          let at = 13,
            byte = header[12]!,
            listed = byte & 15,
            shift = 4;
          while (byte & 128) {
            if (at >= header.length) return;
            invariant(shift <= 49, 'ARTIFACT_INTEGRITY', 'GitHub blob pack size is invalid.');
            byte = header[at++]!;
            listed += (byte & 127) * 2 ** shift;
            shift += 7;
          }
          invariant(listed === entry.size, 'ARTIFACT_INTEGRITY', 'GitHub blob differs from its pinned size.');
          part = header.subarray(at);
          header = Buffer.alloc(0);
          started = true;
        }
        // Keep the pack trailer out of the zlib stream. fetchGitPack verifies it.
        const joined = Buffer.concat([tail, part]),
          keep = Math.min(joined.length, 20);
        tail = Buffer.from(joined.subarray(joined.length - keep));
        if (joined.length > keep) await writer.write(joined.subarray(0, joined.length - keep));
      },
    );
    invariant(started, 'ARTIFACT_INTEGRITY', 'GitHub blob pack has no object.');
    await writer.close();
    await read;
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await read.catch(() => {});
    if (error instanceof PackLimitError)
      throw new ForgeError('ARTIFACT_INTEGRITY', 'GitHub blob pack exceeds its pinned size.');
    throw error;
  } finally {
    writer.releaseLock();
  }
  invariant(
    size === entry.size && git.digest('hex') === entry.sha,
    'ARTIFACT_INTEGRITY',
    'GitHub blob differs from the selected commit.',
  );
  return { blob: logical.digest('hex'), size };
}
