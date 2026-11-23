// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
/** SHA-256 shared by Node reducers and Convex's V8 runtime. */
export const digest = (value: string | Uint8Array): string =>
  bytesToHex(sha256(typeof value === 'string' ? utf8ToBytes(value) : value));
/** Raw SHA-256 and hex for byte protocols (sealed format); one import keeps one bundle chunk. */
export const sha256Bytes = (value: Uint8Array): Uint8Array => sha256(value);
export const hexBytes = (value: Uint8Array): string => bytesToHex(value);

/** Incremental portable hashing for exact JSON/source chunks. */
export function digestChunks(chunks: Iterable<string | Uint8Array>): string {
  const hash = sha256.create();
  for (const chunk of chunks) hash.update(typeof chunk === 'string' ? utf8ToBytes(chunk) : chunk);
  return bytesToHex(hash.digest());
}
