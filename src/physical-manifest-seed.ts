// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { packRunMaxBytes } from './object-pack-range.js';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import { jobObject } from './hosted-source-job.js';
import {
  physicalBucket,
  encodePhysicalEntries,
  decodePhysicalEntries,
  type PhysicalEntry,
} from './physical-manifest-codec.js';
import { encodePhysicalRoot } from './physical-manifest-root.js';
import type { PhysicalManifest } from './physical-manifest.js';
import { sourceSeedPageSize } from './source-object-window.js';
import type { WorkerPin } from './hosted-source-worker-format.js';

const chunk = z.object({
  bucket: z.number().int().min(0).max(1023),
  sha256: z.string(),
  size: z.number(),
  pack: z.object({ digest: z.string(), size: z.number(), offset: z.number() }).optional(),
});
const cursor = z
  .object({
    kind: z.literal('forge-physical-seed-v1'),
    state: jobObject,
    index: jobObject,
    pages: z.array(z.string()),
    count: z.number().int().nonnegative(),
    next: z.number().int().nonnegative(),
    pending: z.array(z.unknown()),
    chunks: z.array(chunk),
    pack: jobObject.nullable(),
    packChunks: z.array(chunk),
  })
  .strict();
export type PhysicalSeedProgress = z.infer<typeof cursor>;
export type PhysicalSeedIo = {
  put(bytes: Uint8Array): Promise<WorkerPin>;
  read(pin: WorkerPin): Promise<Uint8Array>;
  range(pin: WorkerPin, offset: number, size: number): Promise<Uint8Array>;
  describe(ids: string[]): Promise<{ rows: (PhysicalEntry | null)[]; next: number }>;
};
export function parsePhysicalSeed(bytes: Uint8Array): PhysicalSeedProgress {
  const value = cursor.parse(JSON.parse(new TextDecoder().decode(bytes)));
  invariant(
    value.next <= value.count &&
      value.index.size === value.count * 32 &&
      value.pages.length === Math.ceil(value.count / sourceSeedPageSize),
    'SOURCE_HASH_MISMATCH',
    'Physical seed progress differs from its membership index.',
  );
  return value;
}
/** One immutable, hash-paged index from a verified State. Later steps fetch just
 * 32 KB, never re-read the State or all earlier descriptor pages. */
export async function startPhysicalSeed(state: WorkerPin, members: readonly string[], io: PhysicalSeedIo) {
  const ids = [...new Set(members)].sort(),
    bytes = new Uint8Array(ids.length * 32),
    pages: string[] = [];
  ids.forEach((id, at) => bytes.set(Buffer.from(id, 'hex'), at * 32));
  for (let at = 0; at < bytes.length; at += sourceSeedPageSize * 32)
    pages.push(digest(bytes.subarray(at, at + sourceSeedPageSize * 32)));
  return {
    kind: 'forge-physical-seed-v1' as const,
    state,
    index: await io.put(bytes),
    pages,
    count: ids.length,
    next: 0,
    pending: [],
    chunks: [],
    pack: null,
    packChunks: [],
  };
}
/** Exactly one query-budgeted resolver prefix per scheduled step. Bucket and pack
 * tails survive restart in R2; only complete, fully-live packs enter the root. */
export async function advancePhysicalSeed(c: PhysicalSeedProgress, io: PhysicalSeedIo) {
  const outputs: WorkerPin[] = [];
  let body = c.pack ? await io.read(c.pack) : new Uint8Array();
  const flush = async () => {
    if (!c.packChunks.length) return;
    const pin = await io.put(body);
    outputs.push(pin);
    for (const part of c.packChunks)
      c.chunks.push({ ...part, pack: { digest: pin.sha256, size: pin.size, offset: part.pack!.offset } });
    c.packChunks = [];
    body = new Uint8Array();
    c.pack = null;
  };
  const bucket = async () => {
    const entries = c.pending as PhysicalEntry[];
    if (!entries.length) return;
    const bytes = encodePhysicalEntries(entries),
      id = physicalBucket(entries[0]!.sha256);
    // Round-trip the exact membership and bindings before any root can name them.
    invariant(
      decodePhysicalEntries(bytes, id).length === entries.length,
      'SOURCE_HASH_MISMATCH',
      'Physical seed bucket verification failed.',
    );
    // Target at most fifty packs at any supported scale; this is an internal
    // page shape, never a repository or user limit.
    const target = Math.min(packRunMaxBytes, Math.max(128 * 1024, Math.ceil((c.count * 256) / 50)));
    if (body.length && body.length + bytes.length > target) await flush();
    const joined = new Uint8Array(body.length + bytes.length);
    joined.set(body);
    joined.set(bytes, body.length);
    c.packChunks.push({
      bucket: id,
      sha256: digest(bytes),
      size: bytes.length,
      pack: { digest: '', size: 0, offset: body.length },
    });
    body = joined;
    c.pending = [];
  };
  if (c.next < c.count) {
    const page = Math.floor(c.next / sourceSeedPageSize),
      start = page * sourceSeedPageSize,
      size = Math.min(sourceSeedPageSize, c.count - start) * 32,
      bytes = await io.range(c.index, start * 32, size);
    invariant(
      bytes.length === size && digest(bytes) === c.pages[page],
      'SOURCE_HASH_MISMATCH',
      'Physical seed index page changed.',
    );
    const ids: string[] = [];
    for (let at = (c.next - start) * 32; at < size; at += 32)
      ids.push(Buffer.from(bytes.subarray(at, at + 32)).toString('hex'));
    const found = await io.describe(ids);
    invariant(
      Number.isInteger(found.next) &&
        found.next > 0 &&
        found.next <= ids.length &&
        found.rows.length === found.next &&
        found.rows.every((entry, at) => !entry || entry.sha256 === ids[at]),
      'SOURCE_HASH_MISMATCH',
      'Physical seed resolver prefix changed identity or progress.',
    );
    if (found.rows.some(entry => !entry)) return { progress: c, outputs, root: null, done: true };
    for (const entry of found.rows as PhysicalEntry[]) {
      const previous = c.pending.at(-1) as PhysicalEntry | undefined;
      if (previous && physicalBucket(previous.sha256) !== physicalBucket(entry.sha256)) await bucket();
      c.pending.push(entry);
    }
    c.next += found.next;
  }
  if (c.next === c.count) {
    await bucket();
    await flush();
    const manifest: PhysicalManifest = {
      schema: 1,
      kind: 'forge-physical-manifest',
      state: c.state.sha256,
      chunks: c.chunks,
    };
    const root = await io.put(encodePhysicalRoot(manifest));
    outputs.push(root);
    return { progress: c, outputs, root, done: true };
  }
  c.pack = body.length ? await io.put(body) : null;
  return { progress: c, outputs, root: null, done: false };
}
