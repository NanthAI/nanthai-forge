// SPDX-License-Identifier: Apache-2.0
import * as zlib from 'node:zlib';
import { invariant } from './errors.js';

// Physical encoding only: the filename always hashes the original JSON bytes.
const magic = Buffer.from('forge-work-zstd-v1\0');
const codec = zlib as typeof zlib & {
  zstdCompressSync(bytes: Buffer): Buffer;
  zstdDecompressSync(bytes: Buffer): Buffer;
};
export function packRecord(bytes: Buffer): Buffer {
  const packed = Buffer.concat([magic, codec.zstdCompressSync(bytes)]);
  return packed.length < bytes.length ? packed : bytes;
}
export function unpackRecord(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, magic.length).equals(magic)) return bytes;
  try {
    return codec.zstdDecompressSync(bytes.subarray(magic.length));
  } catch {
    invariant(false, 'INVALID_WORK_STORE', 'A compressed Work page is invalid.');
  }
}
