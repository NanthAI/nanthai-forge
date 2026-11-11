// SPDX-License-Identifier: Apache-2.0
import { inflateSync } from 'node:zlib';
import { fetchGitPack, PackLimitError } from './git-upload-pack.js';
import { applyGitDelta } from './git-pack-delta.js';
import { gitBlobId } from './github-archive-source.js';
import type { GithubSourceEntry } from './github-project-source.js';
import { ForgeError, invariant } from './errors.js';

/** One smart-HTTP fetch for a caller's byte-bounded page, including archive-omitted
 * and export-subst files. No REST blob requests and no repository code execution.
 * Git sends only wanted blobs; every result is checked against the pinned listing. */
export async function githubBlobPack(
  repository: string,
  entries: readonly GithubSourceEntry[],
  token?: string,
  request?: typeof fetch,
): Promise<Map<string, Buffer>> {
  const expected = new Map(entries.filter(e => e.mode !== '160000').map(e => [e.sha, e.size]));
  if (!expected.size) return new Map();
  const wants = [...expected.keys()],
    size = [...expected.values()].reduce((a, b) => a + b, 0),
    parts: Buffer[] = [];
  try {
    await fetchGitPack(
      {
        url: `https://github.com/${repository}`,
        want: wants[0]!,
        wants: wants.slice(1),
        ...(token ? { token } : {}),
        ...(request ? { fetch: request } : {}),
        totalTimeoutMs: 120_000, // Retain the source acquisition deadline (history uses 8 minutes).
        // Deflate's worst expansion plus object headers, not a product quota.
        limitBytes: size + Math.ceil(size / 1000) + expected.size * 1024 + 32,
      },
      async part => {
        parts.push(part);
      },
    );
  } catch (error) {
    if (error instanceof PackLimitError)
      throw new ForgeError('ARTIFACT_INTEGRITY', 'GitHub blob pack exceeds its pinned page size.');
    throw error;
  }
  return readBlobPage(Buffer.concat(parts), expected);
}

/** Whole blobs and both Git delta encodings. Bases in this non-thin pack may be
 * named by offset or id; forward id references resolve after their base arrives. */
function readBlobPage(pack: Buffer, expected: Map<string, number>) {
  const fail: (value: unknown) => asserts value = value =>
    invariant(value, 'ARTIFACT_INTEGRITY', 'GitHub blob pack differs from the pinned page.');
  const end = pack.length - 20,
    count = pack.readUInt32BE(8),
    maxSize = Math.max(...expected.values()),
    byOffset = new Map<number, Buffer>(),
    blobs = new Map<string, Buffer>(),
    pending: { offset: number; base: string | number; delta: Buffer }[] = [];
  fail(count === expected.size);
  let at = 12;
  const keep = (offset: number, bytes: Buffer) => {
    const sha = gitBlobId('0'.repeat(40), bytes);
    fail(expected.get(sha) === bytes.length);
    blobs.set(sha, bytes);
    byOffset.set(offset, bytes);
  };
  for (let n = 0; n < count; n++) {
    const offset = at;
    fail(at < end);
    let byte = pack[at++]!,
      size = byte & 15,
      shift = 4;
    const type = (byte >> 4) & 7;
    while (byte & 128) {
      fail(at < end && shift <= 49);
      byte = pack[at++]!;
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }
    fail([3, 6, 7].includes(type) && size <= maxSize + Math.ceil(maxSize / 127) + 64);
    let baseId: string | number | undefined;
    if (type === 6) {
      fail(at < end);
      byte = pack[at++]!;
      let back = byte & 127;
      while (byte & 128) {
        fail(at < end);
        byte = pack[at++]!;
        back = (back + 1) * 128 + (byte & 127);
        fail(Number.isSafeInteger(back));
      }
      baseId = offset - back;
      fail(baseId >= 12 && baseId < offset);
    } else if (type === 7) {
      fail(at + 20 <= end);
      baseId = pack.toString('hex', at, at + 20);
      at += 20;
    }
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(pack.subarray(at, end), {
        info: true,
        maxOutputLength: size + 1,
      }) as unknown as typeof inflated;
    } catch {
      throw new ForgeError('ARTIFACT_INTEGRITY', 'GitHub blob pack contains invalid compressed bytes.');
    }
    fail(inflated.buffer.length === size && inflated.engine.bytesWritten > 0);
    at += inflated.engine.bytesWritten;
    if (baseId !== undefined) pending.push({ offset, base: baseId, delta: inflated.buffer });
    else keep(offset, inflated.buffer);
  }
  fail(at === end);
  while (pending.length) {
    let resolved = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      const row = pending[i]!,
        base = typeof row.base === 'number' ? byOffset.get(row.base) : blobs.get(row.base);
      if (!base) continue;
      keep(row.offset, applyGitDelta(base, row.delta, maxSize));
      pending.splice(i, 1);
      resolved++;
    }
    fail(resolved > 0);
  }
  fail(blobs.size === expected.size);
  return blobs;
}
