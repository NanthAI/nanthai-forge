// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { snapshotHead, snapshotByKey, snapshotPage } from './projectHostedSnapshots';
import { snapshotDocument } from './projectHostedSnapshotFields';
import { hostedRef } from './projectHostedRecordFields';
import { invariant } from '../src/errors';

export const current = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string() },
  returns: v.union(snapshotDocument, v.null()),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.actor);
    const head = await snapshotHead(ctx, input.projectId);
    return head ? ctx.db.get(head.snapshotId) : null;
  },
});
/** Exact immutable pages remain readable after a newer snapshot is selected. */
export const page = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), snapshotId: v.string(), page: v.number() },
  returns: v.union(
    v.object({ page: v.number(), root: v.string(), previousRoot: v.string(), refs: v.array(hostedRef) }),
    v.null(),
  ),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.actor);
    const snapshot = await snapshotByKey(ctx, input.projectId, input.snapshotId);
    invariant(
      snapshot?.status === 'published',
      'SOURCE_UNAVAILABLE',
      'The exact published snapshot is unavailable.',
    );
    const row = await snapshotPage(ctx, snapshot._id, input.page);
    return row ? { page: row.page, root: row.root, previousRoot: row.previousRoot, refs: row.refs } : null;
  },
});
