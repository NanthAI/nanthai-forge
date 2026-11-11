// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { ObjectPack } from './object-pack-range.js';
import { PhysicalReader, PhysicalWriter } from './physical-manifest-binary.js';
export type PhysicalPin = {
  sha256: string;
  size: number;
  nonce?: string | undefined;
  pack?: (ObjectPack & { nonce?: string | undefined }) | undefined;
};
export type PhysicalEntry = PhysicalPin & { recipe?: { sha256: string; size: number } };
const valid = (ok: unknown) =>
  invariant(ok, 'SOURCE_HASH_MISMATCH', 'Physical manifest encoding is invalid.');
/** Fixed digest buckets keep point reads to one chunk, independent of tree size.
 * FPM2 additionally preserves exact nonce keys; canonical FPM1 stays byte-identical. */
export const physicalBucket = (id: string) => Number.parseInt(id.slice(0, 3), 16) >> 2;
export function encodePhysicalEntries(entries: readonly PhysicalEntry[]): Uint8Array {
  const version = entries.some(entry => entry.nonce !== undefined || entry.pack?.nonce !== undefined) ? 2 : 1;
  const out = new PhysicalWriter([70, 80, 77, version]);
  out.integer(entries.length);
  let last = '';
  for (const entry of entries) {
    valid(
      entry.sha256 > last &&
        !(entry.pack && entry.recipe) &&
        !(entry.nonce !== undefined && (entry.pack || entry.recipe)),
    );
    last = entry.sha256;
    out.hash(entry.sha256);
    out.integer(entry.size);
    out.byte(entry.recipe ? 2 : entry.pack ? 1 : 0);
    if (entry.recipe) {
      out.hash(entry.recipe.sha256);
      out.integer(entry.recipe.size);
    } else if (entry.pack) {
      out.hash(entry.pack.digest);
      out.integer(entry.pack.size);
      out.integer(entry.pack.offset);
      if (version === 2) out.nonce(entry.pack.nonce);
      valid(
        entry.size > 0 &&
          Number.isSafeInteger(entry.pack.offset + entry.size) &&
          entry.pack.offset + entry.size <= entry.pack.size,
      );
    } else if (version === 2) out.nonce(entry.nonce);
  }
  return out.finish();
}
export function decodePhysicalEntries(bytes: Uint8Array, bucket: number): PhysicalEntry[] {
  const version = bytes[3];
  valid(bytes[0] === 70 && bytes[1] === 80 && bytes[2] === 77 && (version === 1 || version === 2));
  const input = new PhysicalReader(bytes),
    count = input.integer(),
    entries: PhysicalEntry[] = [];
  valid(count <= Math.floor(input.remaining / 34));
  let last = '';
  for (let index = 0; index < count; index++) {
    const sha256 = input.hash(),
      size = input.integer(),
      kind = input.byte();
    valid(sha256 > last && physicalBucket(sha256) === bucket && kind <= 2);
    last = sha256;
    const entry: PhysicalEntry = { sha256, size };
    if (kind === 2) entry.recipe = { sha256: input.hash(), size: input.integer() };
    else {
      if (kind === 1) {
        entry.pack = { digest: input.hash(), size: input.integer(), offset: input.integer() };
        valid(
          size > 0 &&
            Number.isSafeInteger(entry.pack.offset + size) &&
            entry.pack.offset + size <= entry.pack.size,
        );
      }
      const nonce = version === 2 ? input.nonce() : undefined;
      if (nonce !== undefined) {
        if (entry.pack) entry.pack.nonce = nonce;
        else entry.nonce = nonce;
      }
    }
    entries.push(entry);
  }
  input.finish();
  return entries;
}
