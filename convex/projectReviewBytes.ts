// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { rawContent, rawKey } from './projectObjectContent';
import type { ObjectView } from './projectObjectFind';

// Verified raw storage bytes only. The caller must freshly authorize and validate storage metadata
// before using this memo. Never memoize project rows, recipe closures or authorization decisions.
const entries = new Map<string, Buffer>();
let size = 0;
const budget = 16 * 1024 * 1024;
export async function reviewBytes(ctx: ActionCtx, row: ObjectView, pin: { sha256: string; size: number }) {
  const key = JSON.stringify([row.projectId, rawKey(row), pin.sha256, pin.size]);
  const hit = entries.get(key);
  if (hit) return Buffer.from(hit);
  const bytes = await rawContent(ctx, row, pin);
  if (bytes.length <= budget) {
    while (size + bytes.length > budget) {
      const oldest = entries.keys().next().value!;
      size -= entries.get(oldest)!.length;
      entries.delete(oldest);
    }
    const previous = entries.get(key);
    if (previous) size -= previous.length;
    entries.set(key, Buffer.from(bytes));
    size += bytes.length;
  }
  return bytes;
}
