// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
/** SHA-256 shared by Node reducers and Convex's V8 runtime. */
export const digest = (value: string | Uint8Array): string =>
  bytesToHex(sha256(typeof value === 'string' ? utf8ToBytes(value) : value));

/** Incremental portable hashing for exact JSON/source chunks. */
export function digestChunks(chunks: Iterable<string | Uint8Array>): string {
  const hash = sha256.create();
  for (const chunk of chunks) hash.update(typeof chunk === 'string' ? utf8ToBytes(chunk) : chunk);
  return bytesToHex(hash.digest());
}
