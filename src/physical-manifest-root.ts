// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { PhysicalManifest } from './physical-manifest.js';
import { PhysicalReader, PhysicalWriter, physicalKey } from './physical-manifest-binary.js';
const valid = (ok: unknown) => invariant(ok, 'SOURCE_HASH_MISMATCH', 'Physical manifest recipe is invalid.');
/** FPR1 is unchanged. FPR2 permits omitted membership fingerprints and nonce packs.
 * A writer reusing such a bucket must compare verified parent-State membership. */
export function encodePhysicalRoot(root: PhysicalManifest): Uint8Array {
  const version = root.chunks.some(chunk => !chunk.members || chunk.pack?.nonce !== undefined) ? 2 : 1;
  const out = new PhysicalWriter([70, 80, 82, version]);
  out.hash(root.state);
  const packs = [
    ...new Map(
      root.chunks.flatMap(chunk =>
        chunk.pack ? [[physicalKey(chunk.pack.digest, chunk.pack.nonce), chunk.pack]] : [],
      ),
    ).values(),
  ].sort((a, b) => physicalKey(a.digest, a.nonce).localeCompare(physicalKey(b.digest, b.nonce)));
  const packIndices = new Map(packs.map((pack, index) => [physicalKey(pack.digest, pack.nonce), index + 1]));
  out.integer(packs.length);
  for (const pack of packs) {
    out.hash(pack.digest);
    out.integer(pack.size);
    if (version === 2) out.nonce(pack.nonce);
  }
  out.integer(root.chunks.length);
  let last = -1;
  for (const chunk of root.chunks) {
    valid(chunk.bucket > last && chunk.bucket < 1024);
    last = chunk.bucket;
    out.integer(chunk.bucket);
    out.hash(chunk.sha256);
    out.integer(chunk.size);
    if (version === 2) out.byte(chunk.members ? 1 : 0);
    if (chunk.members) out.hash(chunk.members);
    const pack = chunk.pack ? packIndices.get(physicalKey(chunk.pack.digest, chunk.pack.nonce))! : 0;
    out.integer(pack);
    if (chunk.pack) {
      valid(
        packs[pack - 1]!.size === chunk.pack.size &&
          chunk.size > 0 &&
          Number.isSafeInteger(chunk.pack.offset + chunk.size) &&
          chunk.pack.offset + chunk.size <= chunk.pack.size,
      );
      out.integer(chunk.pack.offset);
    }
  }
  return out.finish();
}
export function decodePhysicalRoot(bytes: Uint8Array): PhysicalManifest {
  const version = bytes[3];
  valid(bytes[0] === 70 && bytes[1] === 80 && bytes[2] === 82 && (version === 1 || version === 2));
  const input = new PhysicalReader(bytes),
    state = input.hash(),
    packCount = input.integer();
  valid(packCount <= 1024 && packCount <= input.remaining / 33);
  const packs = Array.from({ length: packCount }, () => {
    const digest = input.hash(),
      size = input.integer(),
      nonce = version === 2 ? input.nonce() : undefined;
    return { digest, size, ...(nonce === undefined ? {} : { nonce }) };
  });
  valid(
    packs.every(
      (pack, index) =>
        !index ||
        physicalKey(packs[index - 1]!.digest, packs[index - 1]!.nonce) < physicalKey(pack.digest, pack.nonce),
    ),
  );
  const count = input.integer();
  valid(count <= 1024 && count <= input.remaining / (version === 1 ? 67 : 36));
  const chunks: PhysicalManifest['chunks'] = [];
  for (let index = 0; index < count; index++) {
    const bucket = input.integer(),
      sha256 = input.hash(),
      size = input.integer(),
      present = version === 1 ? 1 : input.byte();
    valid(present <= 1);
    const members = present ? input.hash() : undefined,
      pack = input.integer();
    valid(bucket < 1024 && (!index || chunks[index - 1]!.bucket < bucket) && pack <= packs.length);
    chunks.push({
      bucket,
      sha256,
      size,
      ...(members === undefined ? {} : { members }),
      ...(pack ? { pack: { ...packs[pack - 1]!, offset: input.integer() } } : {}),
    });
  }
  input.finish();
  return { schema: 1, kind: 'forge-physical-manifest', state, chunks };
}
