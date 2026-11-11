// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { ObjectPack } from './object-pack-range.js';
export type PhysicalPin = { sha256: string; size: number; pack?: ObjectPack | undefined };
export type PhysicalEntry = PhysicalPin & { recipe?: { sha256: string; size: number } };
const valid = (ok: unknown) =>
  invariant(ok, 'SOURCE_HASH_MISMATCH', 'Physical manifest encoding is invalid.');
/** Fixed digest buckets keep point reads to one chunk, independent of tree size.
 * Binary entries avoid repeating JSON keys and hex encodings in every binding. */
export const physicalBucket = (id: string) => Number.parseInt(id.slice(0, 3), 16) >> 2;
export function encodePhysicalEntries(entries: readonly PhysicalEntry[]): Uint8Array {
  const bytes: number[] = [70, 80, 77, 1];
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
  integer(entries.length);
  let last = '';
  for (const entry of entries) {
    valid(entry.sha256 > last && !(entry.pack && entry.recipe));
    last = entry.sha256;
    hash(entry.sha256);
    integer(entry.size);
    bytes.push(entry.recipe ? 2 : entry.pack ? 1 : 0);
    if (entry.recipe) {
      hash(entry.recipe.sha256);
      integer(entry.recipe.size);
    } else if (entry.pack) {
      hash(entry.pack.digest);
      integer(entry.pack.size);
      integer(entry.pack.offset);
      valid(entry.size > 0 && entry.pack.offset + entry.size <= entry.pack.size);
    }
  }
  return Uint8Array.from(bytes);
}
export function decodePhysicalEntries(bytes: Uint8Array, bucket: number): PhysicalEntry[] {
  let at = 4;
  valid(bytes[0] === 70 && bytes[1] === 80 && bytes[2] === 77 && bytes[3] === 1);
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
  const count = integer(),
    entries: PhysicalEntry[] = [];
  valid(count <= Math.floor((bytes.length - at) / 34));
  let last = '';
  for (let index = 0; index < count; index++) {
    const sha256 = hash(),
      size = integer(),
      kind = bytes[at++];
    valid(sha256 > last && physicalBucket(sha256) === bucket && kind !== undefined && kind <= 2);
    last = sha256;
    const entry: PhysicalEntry = { sha256, size };
    if (kind === 2) entry.recipe = { sha256: hash(), size: integer() };
    if (kind === 1) {
      entry.pack = { digest: hash(), size: integer(), offset: integer() };
      valid(
        size > 0 &&
          Number.isSafeInteger(entry.pack.offset + size) &&
          entry.pack.offset + size <= entry.pack.size,
      );
    }
    entries.push(entry);
  }
  valid(at === bytes.length);
  return entries;
}
