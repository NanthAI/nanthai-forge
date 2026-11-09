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

/** Bytes per pack run: one ranged GET, streamed into its member files. */
export const packRunMaxBytes = 16 * 1024 * 1024;
export type PackRun = { members: number[]; offset: number; length: number; total: number };
/** Runs of requested objects that sit back to back in one stored pack (no gap, so a run's
 * bytes are exactly the requested objects). Only runs of two or more are returned; every
 * other row keeps its own signed range. `index` is the caller's row position. */
export function packRuns(
  rows: readonly { index: number; size: number; pack: ObjectPack }[],
  maxBytes = packRunMaxBytes,
): PackRun[] {
  const byPack = new Map<string, { index: number; size: number; pack: ObjectPack }[]>();
  for (const row of rows) {
    if (row.size <= 0) continue;
    const group = byPack.get(row.pack.digest) ?? [];
    group.push(row);
    byPack.set(row.pack.digest, group);
  }
  const runs: PackRun[] = [];
  for (const group of byPack.values()) {
    group.sort((a, b) => a.pack.offset - b.pack.offset);
    let run: PackRun | null = null;
    for (const row of group) {
      if (run && row.pack.offset === run.offset + run.length && run.length + row.size <= maxBytes) {
        run.members.push(row.index);
        run.length += row.size;
        continue;
      }
      if (run && run.members.length > 1) runs.push(run);
      // A repeated digest (same offset) starts its own singleton, which is never returned.
      run = { members: [row.index], offset: row.pack.offset, length: row.size, total: row.pack.size };
    }
    if (run && run.members.length > 1) runs.push(run);
  }
  return runs;
}
