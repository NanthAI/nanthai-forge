// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
type Db = MutationCtx['db'];
export const lineOwner = (db: Pick<Db, 'query'>, laneId: string) =>
  db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', 'projectLiveLineOwner').eq('sourceId', laneId))
    .unique();
export type LineBinding = {
  laneId: string;
  markId: Id<'projectLiveLineLanes'>;
  ownerId: Id<'projectFinishReadRows'>;
  /** The mark's `retried` when this submission bound it (Item 32e8de50). */
  retried?: true;
};
export type LineOwnerValue = {
  markId: Id<'projectLiveLineLanes'>;
  head: string;
  pageId?: Id<'projectFinishReadRows'>;
};
/** A new save/close removes its binding before an older submission can move it.
 * Ownership pages are never inputs to the reactive line query. */
export async function detachLineOwner(db: Db, owner: Doc<'projectFinishReadRows'> | null) {
  const metadata: LineOwnerValue | null = owner ? JSON.parse(owner.value) : null;
  if (!metadata?.pageId) return;
  const page = await db.get(metadata.pageId);
  if (!page) return;
  const bindings = (JSON.parse(page.value) as LineBinding[]).filter(entry => entry.ownerId !== owner!._id);
  if (bindings.length) await db.patch(page._id, { value: JSON.stringify(bindings) });
  else await db.delete(page._id);
}
