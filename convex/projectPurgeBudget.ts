// SPDX-License-Identifier: Apache-2.0

/** One purge page per transaction (project removal and the import-inventory purge). Rows are read in chunks of 8 and the page stops
 * once it has read 4 MiB, so the worst case (8 maximum-size documents after the
 * budget check) stays near 12 MiB, below Convex's 16 MiB read limit, and the row cap
 * stays far below the 16,000 document write limit. Import inventory rows stay under
 * about 400 KB (a window holds at most 2,001 pins), so that purge reads under 8 MiB. */
export const purgePageBudget = { rows: 1000, bytes: 4 * 1024 * 1024, chunk: 8 } as const;

/** Serialized size estimate, counting byte fields by length. */
export function documentBytes(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((n: number, item) => n + documentBytes(item), 2);
  if (value && typeof value === 'object')
    return Object.entries(value).reduce((n, [key, item]) => n + key.length + 3 + documentBytes(item), 2);
  return JSON.stringify(value ?? null).length;
}
