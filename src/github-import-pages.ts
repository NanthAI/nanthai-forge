// SPDX-License-Identifier: Apache-2.0
/** Scheduling/encoding boundaries, never repository exclusions or user quotas. */
export const importPageFiles = 1000;
export const importPageBytes = 8 * 1024 * 1024;
export const importPageMetadataBytes = 512 * 1024;
export const importPageDirectories = 128;
export const importPageMillis = 120_000;
export type ImportProgress = { schema: 2; directories: number; discovered: number; after: string };
export const initialImportProgress = (): ImportProgress => ({
  schema: 2,
  directories: 0,
  discovered: 1,
  after: '',
});
export function filePage<T extends { size: number }>(
  rows: T[],
  encode: (row: T) => unknown = row => row,
): T[] {
  const result: T[] = [];
  let bytes = 0,
    metadata = 0;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(encode(row))).length;
    if (
      result.length &&
      (result.length >= importPageFiles ||
        bytes + row.size > importPageBytes ||
        metadata + size > importPageMetadataBytes)
    )
      break;
    result.push(row);
    bytes += row.size;
    metadata += size;
  }
  return result;
}

/** Fixed-width code-unit keys preserve the portable State's JS lexical order,
 * including astral names, across provider UTF-8 index boundaries. */
export function importPathKey(path: string) {
  let key = '';
  for (let index = 0; index < path.length; index++)
    key += path.charCodeAt(index).toString(16).padStart(4, '0');
  return key;
}
