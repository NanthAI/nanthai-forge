// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

/** Count only the data graph owned by the tables, never prototypes, V8 caches or the
 * test server's stored rows. This is a structure budget, not an estimate of V8 heap.
 * Map keys/values and array elements count too, so hiding rows in a Map cannot pass.
 * Backing stores are counted once, including unused table capacity and Buffer slabs. */
export function tableRetention(...roots) {
  const seen = new Set(),
    pending = [...roots];
  let objects = 0,
    backingBytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      pending.push(value.buffer);
      continue;
    }
    if (value instanceof ArrayBuffer) {
      backingBytes += value.byteLength;
      continue;
    }
    objects++;
    if (value instanceof Map) for (const [key, entry] of value) pending.push(key, entry);
    if (value instanceof Set) for (const entry of value) pending.push(entry);
    for (const entry of Object.values(value)) pending.push(entry);
  }
  return { objects, backingBytes };
}

export function assertColumnRetention(retained, files) {
  // A few records per 1,000-object pack/window and recipe, never one per file.
  const objectBudget = 32 + 8 * Math.ceil(files / 1000);
  assert.ok(
    retained.objects <= objectBudget,
    `${retained.objects} retained table objects exceeds ${objectBudget}: per-file objects returned`,
  );
  assert.ok(
    retained.backingBytes < files * 300,
    `${retained.backingBytes} table backing bytes exceeds 300 bytes per file`,
  );
}
