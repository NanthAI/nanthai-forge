// SPDX-License-Identifier: Apache-2.0
// Undo after a restore (Item 966cb821). A restore answers with a receipt: the revision it wrote and its own operation
// id. The Undo trash call presents the receipt, so a stale tab or a person who joined after the restore can never
// trash a restored or shared project. No reads: the receipt rides the row the transition already holds.
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';

export const restoreReceipt = v.object({
  restoreId: v.string(),
  revision: v.number(),
  /** Item eb631a53: the new address when a live project took the old one while this one was removed. */
  slug: v.optional(v.string()),
  previousSlug: v.optional(v.string()),
});
export type RestoreReceipt = typeof restoreReceipt.type;

/** The answer of the restore recorded on the row. A retry gets the same one whatever changed since. */
export function receiptOf(lifecycle: NonNullable<Doc<'hostedProjects'>['lifecycle']>): RestoreReceipt {
  return {
    restoreId: lifecycle.operationId,
    revision: lifecycle.expectedRevision + 1,
    ...(lifecycle.address ?? {}),
  };
}

/** True while the project is exactly as that restore left it: no other transition and nobody joined since. */
export function undoOpen(project: Doc<'hostedProjects'>, restoreId: string) {
  const { lifecycle } = project;
  return lifecycle?.action === 'restore' && lifecycle.operationId === restoreId && !lifecycle.shared;
}

/** A person joined after a restore (an accepted invitation): its Undo is closed. */
export async function closeRestoreUndo(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const { lifecycle } = project;
  if (lifecycle?.action === 'restore' && !lifecycle.shared)
    await ctx.db.patch(project._id, { lifecycle: { ...lifecycle, shared: true } });
}
