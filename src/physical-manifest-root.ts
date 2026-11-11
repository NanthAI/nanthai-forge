// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { PhysicalManifest } from './physical-manifest.js';
const valid = (ok: unknown) => invariant(ok, 'SOURCE_HASH_MISMATCH', 'Physical manifest recipe is invalid.');
/** Binary recipe roots share a pack dictionary. Membership fingerprints let a
 * writer find changed buckets from State bytes without scanning descriptors. */
export function encodePhysicalRoot(root: PhysicalManifest): Uint8Array {
  const bytes: number[] = [70, 80, 82, 1];
  const integer = (value: number) => {
    valid(Number.isSafeInteger(value) && value >= 0);
    do {
      const next = value % 128;
      value = Math.floor(value / 128);
      bytes.push(next + (value ? 128 : 0));
    } while (value);
  };
  const hash = (id: string) => {
    valid(/^[a-f0-9]{64}$/.test(id));
    for (let at = 0; at < 64; at += 2) bytes.push(Number.parseInt(id.slice(at, at + 2), 16));
  };
  hash(root.state);
  const packs = [
    ...new Map(root.chunks.flatMap(chunk => (chunk.pack ? [[chunk.pack.digest, chunk.pack]] : []))).values(),
  ].sort((a, b) => a.digest.localeCompare(b.digest));
  integer(packs.length);
  for (const pack of packs) {
    hash(pack.digest);
    integer(pack.size);
  }
  integer(root.chunks.length);
  let last = -1;
  for (const chunk of root.chunks) {
    valid(chunk.bucket > last && chunk.bucket < 1024 && chunk.members);
    last = chunk.bucket;
    integer(chunk.bucket);
    hash(chunk.sha256);
    integer(chunk.size);
    hash(chunk.members!);
    const pack = chunk.pack ? packs.findIndex(pack => pack.digest === chunk.pack!.digest) + 1 : 0;
    integer(pack);
    if (chunk.pack) {
      valid(
        packs[pack - 1]!.size === chunk.pack.size &&
          chunk.size > 0 &&
          chunk.pack.offset + chunk.size <= chunk.pack.size,
      );
      integer(chunk.pack.offset);
    }
  }
  return Uint8Array.from(bytes);
}
export function decodePhysicalRoot(bytes: Uint8Array): PhysicalManifest {
  valid(bytes[0] === 70 && bytes[1] === 80 && bytes[2] === 82 && bytes[3] === 1);
  let at = 4;
  const integer = () => {
    let value = 0,
      multiplier = 1,
      byte: number;
    do {
      valid(at < bytes.length && multiplier <= 2 ** 49);
      byte = bytes[at++]!;
      value += (byte % 128) * multiplier;
      multiplier *= 128;
    } while (byte >= 128);
    valid(Number.isSafeInteger(value) && (multiplier === 128 || byte > 0));
    return value;
  };
  const hash = () => {
    valid(at + 32 <= bytes.length);
    let id = '';
    for (const byte of bytes.subarray(at, at + 32)) id += byte.toString(16).padStart(2, '0');
    at += 32;
    return id;
  };
  const state = hash(),
    packCount = integer();
  valid(packCount <= 1024 && packCount <= (bytes.length - at) / 33);
  const packs = Array.from({ length: packCount }, () => ({ digest: hash(), size: integer() }));
  valid(packs.every((pack, index) => !index || packs[index - 1]!.digest < pack.digest));
  const count = integer();
  valid(count <= 1024 && count <= (bytes.length - at) / 67);
  const chunks: PhysicalManifest['chunks'] = [];
  for (let index = 0; index < count; index++) {
    const bucket = integer(),
      sha256 = hash(),
      size = integer(),
      members = hash(),
      pack = integer();
    valid(bucket < 1024 && (!index || chunks[index - 1]!.bucket < bucket) && pack <= packs.length);
    chunks.push({
      bucket,
      sha256,
      size,
      members,
      ...(pack ? { pack: { ...packs[pack - 1]!, offset: integer() } } : {}),
    });
  }
  valid(at === bytes.length);
  return { schema: 1, kind: 'forge-physical-manifest', state, chunks };
}
