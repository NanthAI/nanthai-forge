// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { computeHunks } from './review-hunks-core.js';
// Immutable blob-pair results only. Callers still authorize and verify current source before using this.
const comparisons = new Map<string, { value: ReturnType<typeof computeHunks>; bytes: number }>();
let retainedBytes = 0;
const cacheBytes = 8 * 1024 * 1024;
export function contextualHunks(original: Buffer, selected: Buffer, context: number) {
  const key = `${digest(original)}:${digest(selected)}:${context}`;
  const hit = comparisons.get(key);
  if (hit) return hit.value;
  const value = computeHunks(original, selected, context);
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= cacheBytes) {
    while (retainedBytes + bytes > cacheBytes) {
      const oldest = comparisons.keys().next().value!;
      retainedBytes -= comparisons.get(oldest)!.bytes;
      comparisons.delete(oldest);
    }
    comparisons.set(key, { value, bytes });
    retainedBytes += bytes;
  }
  return value;
}
