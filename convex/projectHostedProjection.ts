// SPDX-License-Identifier: Apache-2.0
import { JournalNeeded, journalReadReply } from './projectJournalStore';
import { journalSegmentSchema } from '../src/journal-segment';
import { v } from 'convex/values';
import { internalMutation } from './server';
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
    segments: v.optional(v.array(v.string())),
  },
  returns: v.union(v.number(), v.string()),
  handler: async (original, input) => {
    const ctx = {
      ...original,
      journalPrivate: true,
      journalLoaded: (input.segments ?? []).map(text => journalSegmentSchema.parse(JSON.parse(text))),
    };
    try {
      await activeProject(ctx, input.projectId, input.actor);
      const snapshot = await snapshotByKey(ctx, input.projectId, input.snapshotId);
      invariant(
        snapshot?.status === 'published',
        'SOURCE_UNAVAILABLE',
        'Rebuild from an exact published snapshot.',
      );
      const page = await snapshotPage(ctx, snapshot._id, input.page);
      invariant(page, 'NOT_FOUND', 'Snapshot page is unavailable.');
      const selected = [];
      for (const ref of page.refs) {
        const row = await recordVersion(ctx, input.projectId, ref.kind, ref.key, ref.version);
        invariant(
          row && row.digest === ref.digest,
          'SOURCE_UNAVAILABLE',
          'The canonical record is unavailable.',
        );
        selected.push({ row, body: await hostedRecordBody(ctx, row) });
      }
      for (const { row, body } of selected) {
        const old = await ctx.db
          .query('projectHostedDisplayRecords')
          .withIndex('by_snapshot_and_kind_and_key_and_version', q =>
            q
              .eq('snapshotId', snapshot._id)
              .eq('kind', row.kind)
              .eq('key', row.key)
              .eq('version', row.version),
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
    } catch (error) {
      if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
      throw error;
    }
  },
});
