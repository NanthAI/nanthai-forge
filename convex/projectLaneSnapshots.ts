// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, query } from './cliServer';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject, activeProject } from './projectAuthority';
import { saveLane } from './projectHostedSaveStore';
import { requireMemberAuthorityById } from './projectLaneAuthority';
import { presignGet, presignPut, putExpiry, r2Config } from './r2';
import { effectivePolicy } from '../src/autonomy-policy';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import {
  LANE_SNAPSHOT,
  laneSnapshotKey,
  snapshotPrepareSchema,
  type SnapshotEntry,
} from '../src/lane-snapshot-contract';

/**
 * Unsaved-work snapshots (Issue 7ac4e32f). Hidden saves that never move the Lane head, land, run
 * checks or raise notices. Per changed snapshot: `prepare` (one Lane row read, the newest entry,
 * at most one insert and one patch, and signed create-only PUTs for the objects it names) and
 * `commit` (one indexed read and one patch). A snapshot with nothing to upload is live after
 * `prepare` alone; an unchanged tree is refused by the client before any call.
 */
type Row = Doc<'projectLaneSnapshots'>;
const laneArgs = { projectId: v.id('hostedProjects'), laneId: v.string() };
const drop = makeFunctionReference<'action'>('projectLaneSnapshotDrop:run');

async function signedIn(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use Lane snapshots.');
  return user.subject;
}
/** The Lane author or the project owner, on a project the caller can still read. */
async function laneFor(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const actor = await signedIn(ctx);
  const lane = await saveLane(ctx, { projectId, actor, laneId });
  await requireMemberAuthorityById(ctx, projectId, lane.actor, actor, 'Lane');
  return { actor, lane };
}
export const laneRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectLaneSnapshots')
    .withIndex('by_project_and_lane_and_seq', q =>
      q.eq('projectId', projectId).eq('laneId', laneId).eq('seq', 0),
    )
    .unique();
const newestEntry = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectLaneSnapshots')
    .withIndex('by_project_and_lane_and_seq', q =>
      q.eq('projectId', projectId).eq('laneId', laneId).gt('seq', 0),
    )
    .order('desc')
    .first();
const byOperation = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('projectLaneSnapshots')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
/** The snapshot an entry leaves the working files at. */
const resolved = (row: Row) => (row.kind === 'restore' ? row.target! : row.seq);
function entry(row: Row): SnapshotEntry {
  return {
    seq: row.seq,
    kind: row.kind as 'snapshot' | 'restore',
    at: new Date(row.at).toISOString(),
    head: row.head!,
    tree: row.tree!,
    pages: row.pages ?? null,
    ...(row.pack ? { pack: row.pack } : {}),
    changeCount: row.changeCount ?? 0,
    ...(row.parent !== undefined ? { parent: row.parent } : {}),
    ...(row.target !== undefined ? { target: row.target } : {}),
    ...(row.move ? { move: row.move } : {}),
    uploadBytes: row.uploadBytes ?? 0,
    notSaved: row.notSaved ?? 0,
  };
}
function requireOpen(lane: Row | null) {
  invariant(
    lane?.state !== 'purging',
    'WORK_BUSY',
    "This Lane's snapshots are being deleted; snapshot again once the purge finishes.",
  );
}
/** Append an entry and move the Lane row: next seq, reserved bytes and expiry. The first entry
 * of a Lane schedules its one expiry job; later entries only push `expiresAt` (the job reschedules
 * itself when it wakes early), so no entry ever schedules more than one job per Lane. */
async function append(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  lane: Row | null,
  fields: Omit<Row, '_id' | '_creationTime' | 'projectId' | 'laneId' | 'seq' | 'at'>,
) {
  const at = Date.now(),
    expiresAt = at + LANE_SNAPSHOT.retentionMs,
    seq = lane?.nextSeq ?? 1;
  await ctx.db.insert('projectLaneSnapshots', { projectId, laneId, seq, at, ...fields });
  const totals = {
    nextSeq: seq + 1,
    laneBytes: (lane?.laneBytes ?? 0) + (fields.uploadBytes ?? 0),
    expiresAt,
  };
  if (lane) {
    await ctx.db.patch(lane._id, totals);
    return { seq, store: lane._id };
  }
  const job = await ctx.scheduler.runAt(expiresAt, drop, { projectId, laneId, reason: 'expiry' });
  const store = await ctx.db.insert('projectLaneSnapshots', {
    projectId,
    laneId,
    seq: 0,
    kind: 'lane',
    actor: fields.actor,
    operationId: `lane:${laneId}`,
    at,
    state: 'live',
    job,
    ...totals,
  });
  return { seq, store };
}
async function targets(
  projectId: string,
  laneId: string,
  uploads: readonly { sha256: string; size: number }[],
) {
  if (!uploads.length) return [];
  const config = r2Config();
  return Promise.all(
    uploads.map(async pin => {
      const put = await presignPut(config, laneSnapshotKey(projectId, laneId, pin.sha256), {
        digest: pin.sha256,
        size: pin.size,
      });
      return { sha256: pin.sha256, url: put.url, headers: put.headers };
    }),
  );
}

export const prepare = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = snapshotPrepareSchema.parse(JSON.parse(input.request));
      const actor = await signedIn(ctx);
      const project = await activeProject(ctx, input.projectId, actor);
      invariant(
        effectivePolicy(project).autoSnapshot === true,
        'SNAPSHOTS_OFF',
        'Lane snapshots are off for this project (policy autoSnapshot). Nothing was stored.',
      );
      const { lane } = await laneFor(ctx, input.projectId, request.laneId);
      invariant(lane.state === 'active', 'LANE_NOT_ACTIVE', 'Snapshots are taken only of open Lanes.');
      const retried = await byOperation(ctx, input.projectId, request.operationId);
      if (retried) {
        invariant(
          retried.laneId === request.laneId &&
            retried.tree === request.tree &&
            retried.actor === actor &&
            (retried.pack?.sha256 ?? null) === (request.pack?.sha256 ?? null),
          'WORK_OPERATION_CHANGED',
          'Retry the original snapshot request.',
        );
        const store = await laneRow(ctx, input.projectId, request.laneId);
        return canonicalPayload({
          seq: retried.seq,
          state: retried.state === 'pending' ? 'pending' : 'live',
          store: store?._id ?? null,
          // A packed snapshot is live from `prepare`: a retry means the client may not have
          // finished the PUT, so it is signed again (create-only: a finished PUT is a no-op).
          targets: request.pack
            ? await targets(input.projectId, request.laneId, [request.pack])
            : retried.state === 'pending'
              ? await targets(input.projectId, request.laneId, request.uploads)
              : [],
        });
      }
      const row = await laneRow(ctx, input.projectId, request.laneId);
      requireOpen(row);
      // Objects the client skipped as already sent are gone with a dropped store: resend all.
      if (request.store !== null && request.store !== row?._id)
        return canonicalPayload({ seq: 0, state: 'reset', store: row?._id ?? null, targets: [] });
      const newest = row ? await newestEntry(ctx, input.projectId, request.laneId) : null;
      if (newest && newest.state === 'live' && newest.tree === request.tree)
        return canonicalPayload({ seq: resolved(newest), state: 'unchanged', store: row!._id, targets: [] });
      const bytes = request.pack
        ? request.pack.size
        : request.uploads.reduce((sum, pin) => sum + pin.size, 0);
      if (bytes > LANE_SNAPSHOT.snapshotBytes || (row?.laneBytes ?? 0) + bytes > LANE_SNAPSHOT.laneBytes)
        throw new ForgeError(
          'QUOTA_EXCEEDED',
          `A snapshot may upload at most ${LANE_SNAPSHOT.snapshotBytes} bytes and a Lane may hold ${LANE_SNAPSHOT.laneBytes} snapshot bytes; this one is ${bytes} bytes. Save explicitly to keep this work. Nothing was stored.`,
        );
      const { seq, store } = await append(ctx, input.projectId, request.laneId, row, {
        kind: 'snapshot',
        actor,
        operationId: request.operationId,
        // Loose uploads wait for `commit`; a pack is the one object, live now.
        state: request.uploads.length ? 'pending' : 'live',
        head: request.head,
        tree: request.tree,
        pages: request.pages,
        ...(request.pack ? { pack: request.pack } : {}),
        changeCount: request.changeCount,
        uploadBytes: bytes,
        notSaved: request.notSaved,
        ...(newest ? { parent: resolved(newest) } : {}),
      });
      return canonicalPayload({
        seq,
        state: request.uploads.length ? 'pending' : 'live',
        store,
        targets: await targets(
          input.projectId,
          request.laneId,
          request.pack ? [request.pack] : request.uploads,
        ),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** The uploads are in R2 (each PUT was create-only and checksum-signed): the entry goes live. */
export const commit = mutation({
  args: { ...laneArgs, operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await signedIn(ctx);
      const row = await byOperation(ctx, input.projectId, input.operationId);
      invariant(
        row && row.laneId === input.laneId && row.actor === actor && row.kind === 'snapshot',
        'NOT_FOUND',
        'No prepared snapshot has this operation id on this Lane.',
      );
      if (row.state === 'pending') await ctx.db.patch(row._id, { state: 'live' });
      return canonicalPayload({ seq: row.seq, state: 'live' });
    } catch (error) {
      return report(error);
    }
  },
});

/** The Lane's operation log, newest first, and its totals. One Lane row and one bounded page. */
export const list = query({
  args: laneArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await laneFor(ctx, input.projectId, input.laneId);
      const row = await laneRow(ctx, input.projectId, input.laneId);
      const rows = row
        ? await ctx.db
            .query('projectLaneSnapshots')
            .withIndex('by_project_and_lane_and_seq', q =>
              q.eq('projectId', input.projectId).eq('laneId', input.laneId).gt('seq', 0),
            )
            .order('desc')
            .take(LANE_SNAPSHOT.listLimit)
        : [];
      return canonicalPayload({
        laneId: input.laneId,
        entries: rows.filter(item => item.state === 'live').map(entry),
        laneBytes: row?.laneBytes ?? 0,
        expiresAt: row?.expiresAt ? new Date(row.expiresAt).toISOString() : null,
        purging: row?.state === 'purging',
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** Signed GETs for this Lane's snapshot objects (restore). Reads only the Lane; signs at most 100. */
export const read = mutation({
  args: { ...laneArgs, digests: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      invariant(
        input.digests.length <= 100,
        'BAD_ARGUMENT',
        'Read snapshot objects in pages of at most 100.',
      );
      invariant(
        input.digests.every(value => /^[0-9a-f]{64}$/.test(value)),
        'BAD_ARGUMENT',
        'Name snapshot objects by sha256.',
      );
      await laneFor(ctx, input.projectId, input.laneId);
      requireOpen(await laneRow(ctx, input.projectId, input.laneId));
      const config = r2Config();
      return canonicalPayload(
        await Promise.all(
          [...new Set(input.digests)].map(async sha256 => ({
            sha256,
            url: await presignGet(config, laneSnapshotKey(input.projectId, input.laneId, sha256)),
          })),
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** Records that the working files now match snapshot `target` (undo, redo or restore). A pointer
 * move: no bytes are copied and nothing is deleted. */
export const restore = mutation({
  args: {
    ...laneArgs,
    operationId: v.string(),
    target: v.number(),
    head: v.string(),
    move: v.union(v.literal('undo'), v.literal('redo'), v.literal('restore')),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await laneFor(ctx, input.projectId, input.laneId);
      invariant(/^[0-9a-f]{64}$/.test(input.head), 'BAD_ARGUMENT', 'Name the checkout head.');
      const retried = await byOperation(ctx, input.projectId, input.operationId);
      if (retried) {
        invariant(
          retried.laneId === input.laneId && retried.target === input.target,
          'WORK_OPERATION_CHANGED',
          'Retry the original restore request.',
        );
        return canonicalPayload({ seq: retried.seq, target: input.target });
      }
      const row = await laneRow(ctx, input.projectId, input.laneId);
      requireOpen(row);
      const target = await ctx.db
        .query('projectLaneSnapshots')
        .withIndex('by_project_and_lane_and_seq', q =>
          q.eq('projectId', input.projectId).eq('laneId', input.laneId).eq('seq', input.target),
        )
        .unique();
      invariant(
        target && target.kind === 'snapshot' && target.state === 'live',
        'NOT_FOUND',
        'That snapshot is not in this Lane’s operation log.',
      );
      const newest = await newestEntry(ctx, input.projectId, input.laneId);
      const { seq } = await append(ctx, input.projectId, input.laneId, row, {
        kind: 'restore',
        actor,
        operationId: input.operationId,
        state: 'live',
        head: input.head,
        tree: target.tree!,
        pages: target.pages ?? null,
        changeCount: target.changeCount ?? 0,
        uploadBytes: 0,
        notSaved: 0,
        target: input.target,
        move: input.move,
        ...(newest ? { parent: resolved(newest) } : {}),
      });
      return canonicalPayload({ seq, target: input.target });
    } catch (error) {
      return report(error);
    }
  },
});

/** Owner purge: delete every snapshot of this Lane for real (R2 objects, then rows). The Lane
 * author or the project owner; new snapshots of the Lane wait until it finishes. */
export const purge = mutation({
  args: laneArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await signedIn(ctx);
      await accessibleProject(ctx, input.projectId, actor);
      await laneFor(ctx, input.projectId, input.laneId);
      const row = await laneRow(ctx, input.projectId, input.laneId);
      if (!row) return canonicalPayload({ laneId: input.laneId, state: 'none', entries: 0 });
      if (row.state !== 'purging') {
        if (row.job) await ctx.scheduler.cancel(row.job);
        const job = await ctx.scheduler.runAfter(0, drop, {
          projectId: input.projectId,
          laneId: input.laneId,
          reason: 'purge',
        });
        // The drop sweeps once more after every PUT URL signed before now has expired.
        await ctx.db.patch(row._id, {
          state: 'purging',
          job,
          expiresAt: Date.now() + (putExpiry + 60) * 1000,
        });
      }
      return canonicalPayload({
        laneId: input.laneId,
        state: 'purging',
        entries: (row.nextSeq ?? 1) - 1,
        bytes: row.laneBytes ?? 0,
      });
    } catch (error) {
      return report(error);
    }
  },
});
