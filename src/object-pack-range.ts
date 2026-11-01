// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

/** An immutable logical object's byte interval inside a project-scoped pack. */
export type ObjectPack = { digest: string; size: number; offset: number };
export type PackRange = { offset: number; total: number };
export const packRange = (row: { pack?: ObjectPack | undefined }): PackRange | undefined =>
  row.pack ? { offset: row.pack.offset, total: row.pack.size } : undefined;

export function packHeaders(range: PackRange | undefined, size: number): Record<string, string> {
  if (!range) return {};
  invariant(
    Number.isSafeInteger(range.offset) &&
      range.offset >= 0 &&
      Number.isSafeInteger(range.total) &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      Number.isSafeInteger(range.offset + size) &&
      range.offset + size <= range.total,
    'INVALID_WORK_BACKUP',
    'Stored pack interval differs from its object binding.',
  );
  return { Range: `bytes=${range.offset}-${range.offset + size - 1}` };
}

export function verifyPackRange(response: Response, range: PackRange | undefined, size: number) {
  if (!range) return;
  packHeaders(range, size);
  invariant(
    response.status === 206 &&
      response.headers.get('content-range') ===
        `bytes ${range.offset}-${range.offset + size - 1}/${range.total}` &&
      (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity'),
    'INVALID_WORK_BACKUP',
    'Object storage returned a different pack interval.',
  );
}
