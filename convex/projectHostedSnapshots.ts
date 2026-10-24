// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { hostedWriteProject, recordVersion } from './projectHostedRecords';
import { snapshotPlan, snapshotProgress, snapshotPageReceipt } from './projectHostedSnapshotFields';
import { hostedRef } from './projectHostedRecordFields';
import {
  hostedSnapshotPlanSchema,
  HOSTED_SNAPSHOT_EMPTY_ROOT,
  hostedSnapshotPageRoot,
} from '../src/hosted-snapshot';
import { validateSnapshotPage } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

export const snapshotHead = (ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedSnapshotHeads')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
export const snapshotByKey = (ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>, key: string) =>
  ctx.db
    .query('projectHostedSnapshots')
    .withIndex('by_project_and_snapshot', q => q.eq('projectId', projectId).eq('snapshotId', key))
    .unique();
export const snapshotPage = (
  ctx: MutationCtx | QueryCtx,
  snapshotId: Id<'projectHostedSnapshots'>,
  page: number,
) =>
  ctx.db
    .query('projectHostedSnapshotPages')
    .withIndex('by_snapshot_and_page', q => q.eq('snapshotId', snapshotId).eq('page', page))
    .unique();
const progress = (row: Doc<'projectHostedSnapshots'>) => ({
  snapshotId: row.snapshotId,
  nextPage: row.nextPage,
  stagedRecords: row.stagedRecords,
  stagedRoot: row.stagedRoot,
  status: row.status,
});

export const begin = internalMutation({
  args: snapshotPlan,
  returns: snapshotProgress,
  handler: async (ctx, input) => {
    await activeProject(ctx, input.projectId, input.actor);
    hostedSnapshotPlanSchema.parse(input);
    const request = canonicalPayload(input);
    const old = await ctx.db
      .query('projectHostedSnapshots')
      .withIndex('by_project_and_actor_and_operation', q =>
        q.eq('projectId', input.projectId).eq('actor', input.actor).eq('operationId', input.operationId),
      )
      .unique();
    if (old) {
      invariant(
        old.request === request,
        'WORK_OPERATION_CHANGED',
        'Resume the original immutable snapshot plan.',
      );
      return progress(old);
    }
    await hostedWriteProject(ctx, input.projectId, input.actor, input.authorityEpoch);
    invariant(
      !(await snapshotByKey(ctx, input.projectId, input.snapshotId)),
      'WORK_OPERATION_CHANGED',
      'Snapshot identity already belongs to another operation.',
    );
    const head = await snapshotHead(ctx, input.projectId);
    invariant(
      (head?.key ?? null) === input.expectedSnapshotId &&
        (!head || input.journalSequence >= head.journalSequence),
      'WORK_STALE',
      'The recovery snapshot changed from its expected selection.',
    );
    if (head) {
      const parent = await ctx.db.get(head.snapshotId);
      invariant(
        parent?.projectId === input.projectId &&
          parent.status === 'published' &&
          canonicalPayload(parent.seedCheckpoint) === canonicalPayload(input.seedCheckpoint),
        'WORK_OPERATION_CHANGED',
        'A snapshot delta retains its original seed checkpoint.',
      );
    }
    const id = await ctx.db.insert('projectHostedSnapshots', {
      ...input,
      request,
      at: Date.now(),
      nextPage: 0,
      stagedRecords: 0,
      stagedRoot: HOSTED_SNAPSHOT_EMPTY_ROOT,
      lastKey: null,
      status: 'staging',
    });
    return progress((await ctx.db.get(id))!);
  },
});
const selection = { projectId: v.id('hostedProjects'), actor: v.string(), snapshotId: v.string() } as const;
export async function writableSnapshot(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; snapshotId: string },
) {
  await activeProject(ctx, input.projectId, input.actor);
  const snapshot = await snapshotByKey(ctx, input.projectId, input.snapshotId);
  invariant(
    snapshot && snapshot.actor === input.actor,
    'NOT_FOUND',
    'The original snapshot operation is unavailable.',
  );
  return snapshot;
}
export const stage = internalMutation({
  args: { ...selection, page: v.number(), previousRoot: v.string(), refs: v.array(hostedRef) },
  returns: snapshotPageReceipt,
  handler: async (ctx, input) => {
    const snapshot = await writableSnapshot(ctx, input);
    const root = hostedSnapshotPageRoot(input.previousRoot, input.page, input.refs);
    const old = await snapshotPage(ctx, snapshot._id, input.page);
    if (old) {
      invariant(old.root === root, 'WORK_OPERATION_CHANGED', 'Retry the original snapshot page.');
      return { page: old.page, root: old.root, records: old.refs.length };
    }
    await hostedWriteProject(ctx, input.projectId, input.actor, snapshot.authorityEpoch);
    invariant(
      snapshot.status === 'staging' &&
        input.page === snapshot.nextPage &&
        input.previousRoot === snapshot.stagedRoot &&
        input.page < snapshot.pageCount,
      'WORK_STALE',
      'Resume snapshot staging at its retained page and root.',
    );
    const { lastKey } = validateSnapshotPage(input.refs, snapshot.lastKey);
    invariant(
      snapshot.stagedRecords + input.refs.length <= snapshot.recordCount,
      'WORK_OPERATION_CHANGED',
      'Snapshot pages exceed the original record count.',
    );
    for (const ref of input.refs) {
      const row = await recordVersion(ctx, input.projectId, ref.kind, ref.key, ref.version);
      invariant(
        row && row.digest === ref.digest && row.bytes === ref.bytes,
        'SOURCE_UNAVAILABLE',
        'An exact canonical record reference is unavailable.',
      );
    }
    await ctx.db.insert('projectHostedSnapshotPages', {
      projectId: input.projectId,
      snapshotId: snapshot._id,
      page: input.page,
      root,
      previousRoot: input.previousRoot,
      refs: input.refs,
    });
    await ctx.db.patch(snapshot._id, {
      nextPage: snapshot.nextPage + 1,
      stagedRecords: snapshot.stagedRecords + input.refs.length,
      stagedRoot: root,
      lastKey,
    });
    return { page: input.page, root, records: input.refs.length };
  },
});
export const publish = internalMutation({
  args: selection,
  returns: snapshotProgress,
  handler: async (ctx, input) => {
    const snapshot = await writableSnapshot(ctx, input);
    // Completed retries return their original result even after a newer selection.
    if (snapshot.status === 'published') return progress(snapshot);
    await hostedWriteProject(ctx, input.projectId, input.actor, snapshot.authorityEpoch);
    invariant(
      snapshot.nextPage === snapshot.pageCount &&
        snapshot.stagedRecords === snapshot.recordCount &&
        snapshot.stagedRoot === snapshot.root,
      'WORK_STALE',
      'Stage every immutable snapshot page before selection.',
    );
    const head = await snapshotHead(ctx, input.projectId);
    invariant(
      (head?.key ?? null) === snapshot.expectedSnapshotId &&
        (!head || snapshot.journalSequence >= head.journalSequence),
      'WORK_STALE',
      'The recovery snapshot changed before selection.',
    );
    const pointer = {
      projectId: input.projectId,
      snapshotId: snapshot._id,
      key: snapshot.snapshotId,
      journalSequence: snapshot.journalSequence,
    };
    if (head) await ctx.db.replace(head._id, pointer);
    else await ctx.db.insert('projectHostedSnapshotHeads', pointer);
    await ctx.db.patch(snapshot._id, { status: 'published' });
    return progress({ ...snapshot, status: 'published' });
  },
});
