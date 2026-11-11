// SPDX-License-Identifier: Apache-2.0
/** Logical State dimensions, authenticated by the fixed writer or a successful exact load.
 * Independent of raw, packed and recipe storage; never part of State identity. */
export type StateSize = { fileCount: number; manifestBytes: number };
export function validStateSize(value: unknown): value is StateSize {
  if (!value || typeof value !== 'object') return false;
  const size = value as StateSize;
  return (
    Number.isSafeInteger(size.fileCount) &&
    size.fileCount >= 0 &&
    Number.isSafeInteger(size.manifestBytes) &&
    size.manifestBytes >= 0
  );
}
