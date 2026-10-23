// SPDX-License-Identifier: Apache-2.0
import type { Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { backfillPin } from './r2BackfillFields';
import { invariant } from '../src/errors';
export type Pin = Infer<typeof backfillPin>;
export const tableFor = {
  objects: 'projectObjects',
  backups: 'projectBackups',
  proposals: 'projectProposals',
  archives: 'projectBackups',
} as const;
type Row = Doc<'projectObjects'> | Doc<'projectBackups'> | Doc<'projectProposals'>;
export function selected(row: Row, kind: Pin['kind']) {
  if (kind === 'archives') return 'archiveReceipt' in row ? row.archiveReceipt : undefined;
  return row;
}
export function eligible(row: Row, kind: Pin['kind']) {
  return kind === 'objects'
    ? !('removed' in row && row.removed) && !('recipe' in row && row.recipe)
    : !('status' in row) || row.status === 'stored';
}
export function pinFor(row: Row, kind: Pin['kind']): Pin | null {
  const source = selected(row, kind);
  if (!eligible(row, kind) || !source?.storageId) return null;
  return {
    kind,
    id: row._id,
    storageId: source.storageId,
    digest: source.digest,
    size: source.size,
    location: source.location ?? null,
  };
}
export async function current(ctx: QueryCtx, projectId: Id<'hostedProjects'>, pin: Pin) {
  invariant(
    ctx.db.normalizeId(tableFor[pin.kind], pin.id),
    'BAD_ARGUMENT',
    'Use the original backfill row pins.',
  );
  const row = await ctx.db.get(pin.id);
  invariant(!row || row.projectId === projectId, 'PROJECT_UNAVAILABLE', 'This backfill row is unavailable.');
  const source = row ? selected(row, pin.kind) : undefined;
  const matches =
    !!row &&
    eligible(row, pin.kind) &&
    source?.storageId === pin.storageId &&
    source.digest === pin.digest &&
    source.size === pin.size;
  return { row, source, matches };
}
