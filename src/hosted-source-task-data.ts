// SPDX-License-Identifier: Apache-2.0
import { gzipSync, gunzipSync } from 'node:zlib';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { parseSourceTaskProgress } from './hosted-source-task-schema.js';
export type SourceTaskData = { id: string; sha256: string };
/** Only decompression corruption proves invalid metadata. Resource/platform
 * failures, including zlib memory errors, must leave the quantum retryable. */
export function inflateSourceMetadata(compressed: Uint8Array): Buffer {
  try {
    return gunzipSync(compressed);
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      !['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_NEED_DICT'].includes(String(error.code))
    )
      throw error;
    throw new ForgeError('SOURCE_HASH_MISMATCH', 'Source metadata encoding changed.');
  }
}
export async function storeTaskData(
  value: unknown,
  store: (bytes: Uint8Array) => Promise<string>,
): Promise<SourceTaskData> {
  const bytes = Buffer.from(JSON.stringify(value));
  return { id: await store(gzipSync(bytes, { level: 1 })), sha256: digest(bytes) };
}
export async function loadTaskData(ref: SourceTaskData, read: (id: string) => Promise<Uint8Array>) {
  invariant(
    ref &&
      typeof ref.id === 'string' &&
      ref.id.length > 0 &&
      typeof ref.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(ref.sha256),
    'SOURCE_JOB_INVALID',
    'Source task reference encoding changed.',
  );
  const compressed = await read(ref.id);
  const bytes = inflateSourceMetadata(compressed);
  invariant(digest(bytes) === ref.sha256, 'SOURCE_HASH_MISMATCH', 'Source task progress changed.');
  try {
    return parseSourceTaskProgress(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ForgeError('SOURCE_HASH_MISMATCH', 'Source task progress encoding changed.');
  }
}
