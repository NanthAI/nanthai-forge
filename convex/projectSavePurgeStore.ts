// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { requireOwnerPerson } from './ownerPerson';
import { activeOwnedProject } from './projectAuthority';
import { findObject, isRegisteredState, purgeTargetRow } from './projectObjectFind';
import { hostedStartMain } from './projectHostedChannels';
import { dropLaneCommit } from './gitServeLaneStore';
import { purgeLaneSnapshots } from './projectLaneSnapshots';
import { denormalized } from './coordinationWrite';
import { r2Key } from './r2';
import { report } from './errors';
import { invariant } from '../src/errors';
import { purgeTombstone } from '../src/save-purge';
import { COORDINATION_LIMITS, type StoredCoordinationCommand } from '../src/coordination-types';

/** Owner purge of one save's stored bytes (Item 9d3c407d). Three steps around the action's State
 * reads and R2 writes: begin checks the owner and replays a known operation, mark refuses or
 * tombstones every selected object in one transaction (reads refuse PURGED from then on), finish
 * records that the bytes are gone. A retry with the same operation id resumes where it stopped. */
const target = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  laneId: v.string(),
  head: v.string(),
  parent: v.string(),
};
/** Tombstone one stored object (Item 9d3c407d): from now on every read of it refuses PURGED. Returns its R2 work
 * (a whole object to delete, or an upload-pack member to zero in place), or nothing when an earlier purge already
 * tombstoned it. Objects stored in chunks (recipes) are the caller's to refuse. Also the base-checkpoint scrub's
 * step (convex/projectCommentPurgeBaseStore.ts). */
export async function tombstoneObject(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: Doc<'projectObjects'>,
  purged: { at: number; operationId: string },
) {
  if (row.purged) return undefined;
  if (row.storageId) await ctx.storage.delete(row.storageId);
  await ctx.db.patch(row._id, { purged, storageId: undefined });
  // A sweep-rotated pack keeps its own key on every member row.
  if (row.pack)
    return {
      zero: { key: row.r2Key ?? r2Key(projectId, row.pack.digest), offset: row.pack.offset, size: row.size },
    };
  return row.r2Key ? { delete: row.r2Key } : {};
}
/** A purge that has not finished its R2 step within this long is taken as abandoned. */
const busyMs = 15 * 60_000;
type Row = Doc<'projectSavePurges'>;

const purgeRow = (ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('projectSavePurges')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
async function owner(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await requireOwnerPerson(ctx, 'purge saved bytes');
  await activeOwnedProject(ctx, projectId, user.subject);
  return user.subject;
}
/** One purge at a time per project rewrites R2: two sharing an upload pack would each restore the
 * other's range. Checked in the same transaction that inserts or resumes a marked row. */
export async function notBusy(ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) {
  const since = Date.now() - busyMs;
  const marked = await ctx.db
    .query('projectSavePurges')
    .withIndex('by_project_and_state', q => q.eq('projectId', projectId).eq('state', 'marked'))
    .order('desc')
    .take(20);
  invariant(
    !marked.some(row => row.operationId !== operationId && (row.leaseAt ?? row.at) >= since),
    'WORK_BUSY',
    'Another purge in this project is still deleting bytes; retry in a minute.',
  );
}
async function laneOf(ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const lane = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  invariant(lane, 'BAD_ARGUMENT', 'Select a Lane of this project.');
  return lane;
}
function sameOperation(row: Row, input: { laneId: string; head: string; parent: string; paths?: string[] }) {
  invariant(
    row.laneId === input.laneId &&
      row.head === input.head &&
      row.parent === input.parent &&
      (!input.paths ||
        [...input.paths].sort().join('\n') ===
          row.files
            .map(file => file.path)
            .sort()
            .join('\n')),
    'WORK_OPERATION_CHANGED',
    'This purge operation id was used for another selection; use a new one.',
  );
  return row;
}

export const begin = internalMutation({
  args: { ...target, paths: v.array(v.string()) },
  returns: v.object({ row: v.union(v.any(), v.null()), main: v.string(), base: v.string() }),
  handler: async (ctx, input) => {
    try {
      await owner(ctx, input.projectId);
      const known = await purgeRow(ctx, input.projectId, input.operationId);
      if (known) {
        sameOperation(known, input);
        if (known.state === 'marked') {
          await notBusy(ctx, input.projectId, input.operationId);
          await ctx.db.patch(known._id, { leaseAt: Date.now() });
        }
        return { row: (await ctx.db.get(known._id))!, main: '', base: '' };
      }
      await notBusy(ctx, input.projectId, input.operationId);
      const lane = await laneOf(ctx, input.projectId, input.laneId);
      const head = await findObject(ctx, input.projectId, input.head);
      invariant(
        head && (await isRegisteredState(ctx, head)),
        'BAD_ARGUMENT',
        'Select a save of this project: its head State is unknown.',
      );
      return { row: null, main: (await hostedStartMain(ctx, input.projectId)).head, base: lane.baseHead };
    } catch (error) {
      return report(error);
    }
  },
});

export const mark = internalMutation({
  args: { ...target, main: v.string(), files: v.array(v.object({ path: v.string(), blob: v.string() })) },
  returns: v.any(),
  handler: async (ctx, input) => {
    try {
      const actor = await owner(ctx, input.projectId);
      const known = await purgeRow(ctx, input.projectId, input.operationId);
      if (known) return sameOperation(known, { ...input, paths: input.files.map(file => file.path) });
      await notBusy(ctx, input.projectId, input.operationId);
      await laneOf(ctx, input.projectId, input.laneId);
      // Main must not have moved since the selection checked it holds none of these bytes.
      invariant(
        (await hostedStartMain(ctx, input.projectId)).head === input.main,
        'WORK_STALE',
        'Main moved while this purge was checked; retry it with a new operation id.',
      );
      const at = Date.now(),
        purged = { at, operationId: input.operationId };
      const deletes = new Set<string>(),
        zero: Row['zero'] = [],
        files: Row['files'] = [];
      for (const file of input.files) {
        const row = await purgeTargetRow(ctx, input.projectId, file.blob);
        invariant(
          row,
          'SOURCE_UNAVAILABLE',
          `The saved bytes of ${JSON.stringify(file.path)} are not stored.`,
        );
        files.push({ ...file, size: row.size });
        invariant(
          row.purged || !row.recipe,
          'BAD_ARGUMENT',
          `${JSON.stringify(file.path)} is stored in chunks (a large file); purge covers files stored whole. Rotate the credential now.`,
        );
        const work = await tombstoneObject(ctx, input.projectId, row, purged);
        if (work?.zero) zero.push(work.zero);
        if (work?.delete) deletes.add(work.delete);
      }
      // Copies that may hold the bytes: the Lane's built Git commit and its snapshots.
      for (const sha of await dropLaneCommit(ctx, input.projectId, input.laneId))
        deletes.add(r2Key(input.projectId, sha));
      await purgeLaneSnapshots(ctx, input.projectId, input.laneId);
      // The tombstone in the Lane's history: what (text), when (at) and by whom (actor).
      const command: StoredCoordinationCommand = {
        kind: 'message',
        text: purgeTombstone(input.head, files).slice(0, COORDINATION_LIMITS.text),
        context: { laneId: input.laneId, head: input.head },
      };
      await ctx.db.insert('projectCoordinationEvents', {
        projectId: input.projectId,
        operationId: input.operationId,
        actor,
        at,
        command,
        ...denormalized(command),
      });
      const id = await ctx.db.insert('projectSavePurges', {
        projectId: input.projectId,
        operationId: input.operationId,
        laneId: input.laneId,
        head: input.head,
        parent: input.parent,
        actor,
        at,
        state: 'marked',
        files,
        deletes: [...deletes],
        zero,
      });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});

export const finish = internalMutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.any(),
  handler: async (ctx, input) => {
    const row = await purgeRow(ctx, input.projectId, input.operationId);
    invariant(row, 'WORK_STALE', 'The purge receipt is missing.');
    if (row.state === 'done') return row;
    await ctx.db.patch(row._id, { state: 'done', doneAt: Date.now() });
    return (await ctx.db.get(row._id))!;
  },
});

/** The value-free receipt an owner gets back, on the first call and on every retry. */
export function purgeReceipt(row: Row) {
  return {
    operationId: row.operationId,
    laneId: row.laneId,
    head: row.head,
    parent: row.parent,
    state: row.state,
    purgedAt: row.at,
    ...(row.doneAt ? { doneAt: row.doneAt } : {}),
    files: row.files.map(({ path, blob, size }) => ({ path, blob, size })),
  };
}
