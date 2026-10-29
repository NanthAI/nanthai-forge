// SPDX-License-Identifier: Apache-2.0
import { gzipSync, gunzipSync } from 'node:zlib';
import { digest } from './hash.js';
import { invariant } from './errors.js';
export type SourceTaskData = { id: string; sha256: string };
export async function storeTaskData(
  value: unknown,
  store: (bytes: Uint8Array) => Promise<string>,
): Promise<SourceTaskData> {
  const bytes = Buffer.from(JSON.stringify(value));
  return { id: await store(gzipSync(bytes, { level: 1 })), sha256: digest(bytes) };
}
export async function loadTaskData<T>(
  ref: SourceTaskData,
  read: (id: string) => Promise<Uint8Array>,
): Promise<T> {
  const bytes = gunzipSync(await read(ref.id));
  invariant(digest(bytes) === ref.sha256, 'SOURCE_HASH_MISMATCH', 'Source task progress changed.');
  return JSON.parse(bytes.toString('utf8')) as T;
}
