// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';

/**
 * Snapshot pack (Issue 7ac4e32f, feature lane-snapshot-packs). One snapshot is ONE create-only R2
 * object: the delta pages and the changed files this Lane's store lacks, so a snapshot costs one
 * PUT and one Convex call however many files changed. Layout: `FLSP1\n`, one JSON header line, then
 * the members back to back in header order. The header holds digests and sizes only (paths live in
 * the pages). `refs` locates files the delta needs that an earlier pack of this Lane already holds,
 * so a file is uploaded once per Lane store, never once per snapshot. A file named by neither a
 * member nor a ref is a loose object of an older snapshot, stored under its own digest.
 */
const MAGIC = Buffer.from('FLSP1\n');
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headerSchema = z
  .object({
    members: z.array(z.tuple([hash, count])),
    refs: z.record(hash, z.tuple([hash, count])),
  })
  .strict();
export type SnapshotPackRefs = Record<string, [string, number]>;
export type SnapshotPack = { bytes: Buffer; pin: { sha256: string; size: number }; members: string[] };

/** Join members (digest-verified by the caller's capture) into a pack. Members must be distinct. */
export function encodeSnapshotPack(
  members: readonly { sha256: string; bytes: Buffer }[],
  refs: SnapshotPackRefs,
): SnapshotPack {
  invariant(
    new Set(members.map(member => member.sha256)).size === members.length,
    'BAD_ARGUMENT',
    'A snapshot pack holds each file once.',
  );
  const header = Buffer.from(
    `${JSON.stringify({
      members: members.map(member => [member.sha256, member.bytes.length]),
      refs: Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1))),
    })}\n`,
  );
  const bytes = Buffer.concat([MAGIC, header, ...members.map(member => member.bytes)]);
  return { bytes, pin: { sha256: digest(bytes), size: bytes.length }, members: members.map(m => m.sha256) };
}

/** Parse a pack read from R2 (already verified against its own digest). Each member is checked
 * against the digest the header names before it is returned. */
export function decodeSnapshotPack(bytes: Buffer): { members: Map<string, Buffer>; refs: SnapshotPackRefs } {
  invariant(
    bytes.subarray(0, MAGIC.length).equals(MAGIC),
    'INVALID_WORK_BACKUP',
    'A snapshot object is not a snapshot pack.',
  );
  const end = bytes.indexOf(10, MAGIC.length);
  invariant(end > 0, 'INVALID_WORK_BACKUP', 'A snapshot pack has no header.');
  const header = headerSchema.parse(JSON.parse(bytes.subarray(MAGIC.length, end).toString('utf8')));
  const members = new Map<string, Buffer>();
  let offset = end + 1;
  for (const [sha256, size] of header.members) {
    const member = bytes.subarray(offset, offset + size);
    invariant(
      member.length === size && digest(member) === sha256,
      'BLOB_DIGEST_MISMATCH',
      'A snapshot pack member differs from its digest. Nothing was used or written.',
    );
    members.set(sha256, member);
    offset += size;
  }
  invariant(offset === bytes.length, 'INVALID_WORK_BACKUP', 'A snapshot pack has trailing bytes.');
  return { members, refs: header.refs };
}
