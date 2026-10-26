// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activeProject } from './projectAuthority';
import { snapshotByKey, snapshotPage } from './projectHostedSnapshots';
import { recordVersion, hostedRecordBody } from './projectHostedRecords';
import { invariant } from '../src/errors';

/** Disposable snapshot-delta display rows. Readers use canonical records for all
 * decisions, and snapshot metadata for completeness; rebuilding never selects
 * main, a Lane, an operation outcome or a recovery snapshot. */
export const rebuildPage = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    snapshotId: v.string(),
    page: v.number(),
    operationId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, input) => {
    await activeProject(ctx, input.projectId, input.actor);
    const snapshot = await snapshotByKey(ctx, input.projectId, input.snapshotId);
    invariant(
      snapshot?.status === 'published',
      'SOURCE_UNAVAILABLE',
      'Rebuild from an exact published snapshot.',
    );
    const page = await snapshotPage(ctx, snapshot._id, input.page);
    invariant(page, 'NOT_FOUND', 'Snapshot page is unavailable.');
    for (const ref of page.refs) {
      const row = await recordVersion(ctx, input.projectId, ref.kind, ref.key, ref.version);
      invariant(
        row && row.digest === ref.digest,
        'SOURCE_UNAVAILABLE',
        'The canonical record is unavailable.',
      );
      const body = await hostedRecordBody(ctx, row);
      const old = await ctx.db
        .query('projectHostedDisplayRecords')
        .withIndex('by_snapshot_and_kind_and_key_and_version', q =>
          q.eq('snapshotId', snapshot._id).eq('kind', ref.kind).eq('key', ref.key).eq('version', ref.version),
        )
        .unique();
      const value = {
        projectId: row.projectId,
        snapshotId: snapshot._id,
        kind: row.kind,
        key: row.key,
        version: row.version,
        parent: row.parent,
        status: row.status,
        value: body,
      };
      if (old) await ctx.db.replace(old._id, value);
      else await ctx.db.insert('projectHostedDisplayRecords', value);
    }
    return page.refs.length;
  },
});
