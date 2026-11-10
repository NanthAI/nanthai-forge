// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './server';
import { findObject } from './projectObjectFind';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import { hostedMainV2Schema } from '../src/hosted-main';
import { sameResolution, sameStack, type OverlapChange } from '../src/hosted-overlap';
import type { TrialTask } from '../src/hosted-trial-merge';
import {
  TRIAL_FILE_BYTES,
  TRIAL_MAIN_STATE_BYTES,
  TRIAL_PATHS,
  TRIAL_PEERS,
  type TrialObject,
  type TrialPlan,
} from '../src/hosted-trial-plan';

/** Exact conflicts at save (flip 4, Issue 853fcde3). A Lane record whose head moved (an explicit save,
 * sync or resolve; hidden snapshots never write the Lane record) plans a trial merge here, inside the
 * record write that already runs: one slim presence range and point reads of the peers that saved a
 * shared file. Nothing shared schedules nothing, so such a save makes no added call. A shared file
 * schedules one action (projectHostedConflictMerge:run) that reads the bytes from R2, merges, and
 * records through one mutation (`record`): two calls, no file bytes in Convex. */

type Row = Doc<'projectHostedOverlapLanes'>;
type Cleared = 'save' | 'landed' | 'abandoned';
const MAIN = 'main';
/** Open rows read per Lane, as the overlap read's peer window. Local (not imported) because this
 * module sits under the Lane record write, which the dormancy and channel modules import. */
const PEER_WINDOW = 51;
const channelRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedChannels')
    .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('name', 'main'))
    .unique();

async function openRows(ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const [mine, about] = await Promise.all([
    ctx.db
      .query('projectHostedConflictNotices')
      .withIndex('by_project_and_lane_and_open', q =>
        q.eq('projectId', projectId).eq('laneId', laneId).eq('open', true),
      )
      .take(PEER_WINDOW),
    ctx.db
      .query('projectHostedConflictNotices')
      .withIndex('by_project_and_peer_and_open', q =>
        q.eq('projectId', projectId).eq('peer', laneId).eq('open', true),
      )
      .take(PEER_WINDOW),
  ]);
  return { mine, about };
}

/** Close this Lane's open notices and the notices other Lanes hold about it, except the pairs `keep`
 * still has to decide. Reads two small index ranges; usually both are empty. */
export async function closeConflictNotices(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  cleared: Cleared,
  keep: ReadonlySet<string> = new Set(),
) {
  const { mine, about } = await openRows(ctx, projectId, laneId);
  const now = Date.now();
  for (const row of mine)
    if (!keep.has(row.peer)) await ctx.db.patch(row._id, { open: false, clearedAt: now, cleared });
  for (const row of about)
    if (!keep.has(row.laneId)) await ctx.db.patch(row._id, { open: false, clearedAt: now, cleared });
  // Nothing left open on either side of this Lane: its later writes skip these reads again.
  if (!keep.size) {
    const lane = await laneRow(ctx, projectId, laneId);
    if (lane?.conflicted) await ctx.db.patch(lane._id, { conflicted: undefined });
  }
}
const laneRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

const changesOf = (row: Pick<Row, 'changes'>): OverlapChange[] => {
  try {
    return JSON.parse(row.changes) as OverlapChange[];
  } catch {
    return [];
  }
};
const fileOf = (file: OverlapChange['before']) => (file ? { blob: file.blob, mode: file.mode } : null);

/** Main's changed paths after the Lane's base, from the main path history the overlap read uses. */
async function mainChanged(ctx: QueryCtx, projectId: Id<'hostedProjects'>, row: Row, paths: Set<string>) {
  if (row.baseSequence === null) return new Set<string>();
  const history = await ctx.db
    .query('projectHostedOverlapMain')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (!history || history.sequence <= row.baseSequence) return new Set<string>();
  const changed = new Set<string>();
  for (const [path, sequence] of JSON.parse(history.changes) as [string, number][])
    if (sequence > row.baseSequence && paths.has(path)) changed.add(path);
  return changed;
}

/** Plan this Lane's trial merge after its record write. `previousHead` is the head before the write. */
export async function planTrialMerge(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: Row,
  previousHead: string | undefined,
) {
  if (!row.open || row.head === previousHead) return;
  const changes = changesOf(row);
  const mine = new Map(changes.map(change => [change.path, change]));
  if (!mine.size)
    return row.conflicted ? closeConflictNotices(ctx, projectId, row.laneId, 'save') : undefined;
  // Slim presence rows name each open Lane's saved paths (complete when pathCount fits); only a peer
  // that may share a file costs a point read of its overlap row.
  const presence = await ctx.db
    .query('projectHostedPresence')
    .withIndex('by_project_and_at', q => q.eq('projectId', projectId))
    .order('desc')
    .take(PEER_WINDOW);
  const candidates = presence
    .filter(
      peer =>
        peer.laneId !== row.laneId &&
        (peer.pathCount > peer.paths.length || peer.paths.some(path => mine.has(path))),
    )
    .slice(0, TRIAL_PEERS * 2);
  const peerRows = (
    await Promise.all(
      candidates.map(peer =>
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', peer.laneId))
          .unique(),
      ),
    )
  ).filter(
    (peer): peer is Row =>
      !!peer &&
      peer.open &&
      peer.superseded?.laneHead !== peer.head &&
      !sameResolution(row, peer) &&
      !sameStack(row, peer),
  );
  const tasks = new Map<string, TrialTask>();
  const peers = new Map<string, { laneId: string; head: string; goal: string }>();
  for (const peer of peerRows) {
    if (peers.size >= TRIAL_PEERS) break;
    let shared = false;
    for (const change of changesOf(peer)) {
      const own = mine.get(change.path);
      if (!own || (tasks.size >= TRIAL_PATHS && !tasks.has(change.path))) continue;
      const task = tasks.get(change.path) ?? {
        path: change.path,
        mine: { before: fileOf(own.before), after: fileOf(own.after) },
        peers: [],
      };
      task.peers.push({
        laneId: peer.laneId,
        before: fileOf(change.before),
        after: fileOf(change.after),
      });
      tasks.set(change.path, task);
      shared = true;
    }
    if (shared)
      peers.set(peer.laneId, {
        laneId: peer.laneId,
        head: peer.head,
        goal: peer.intent,
      });
  }
  const onMain = await mainChanged(ctx, projectId, row, new Set(mine.keys()));
  let main: TrialPlan['main'];
  if (onMain.size) {
    const channel = await channelRow(ctx, projectId);
    const selected = channel ? hostedMainV2Schema.safeParse(JSON.parse(channel.selection)) : null;
    const state = selected?.success ? await findObject(ctx, projectId, selected.data.head) : null;
    if (selected?.success && state && state.size <= TRIAL_MAIN_STATE_BYTES && !state.recipe) {
      main = {
        head: selected.data.head,
        state: trialObject(state),
        paths: [...onMain].slice(0, TRIAL_PATHS),
      };
      for (const path of main.paths)
        if (!tasks.has(path)) {
          const own = mine.get(path)!;
          tasks.set(path, {
            path,
            mine: { before: fileOf(own.before), after: fileOf(own.after) },
            peers: [],
          });
        }
    }
  }
  // Pairs no longer sharing a file (and main when it no longer changes one) close now.
  if (row.conflicted)
    await closeConflictNotices(
      ctx,
      projectId,
      row.laneId,
      'save',
      new Set([...peers.keys(), ...(main ? [MAIN] : [])]),
    );
  if (!tasks.size) return;
  const digests = new Set<string>();
  for (const task of tasks.values())
    for (const file of [task.mine.before, task.mine.after, ...task.peers.flatMap(p => [p.before, p.after])])
      if (file && file.mode !== 'symlink' && file.mode !== 'gitlink') digests.add(file.blob);
  const objects: TrialObject[] = [];
  for (const digest of digests) {
    const found = await findObject(ctx, projectId, digest);
    if (found && !found.recipe && found.size <= TRIAL_FILE_BYTES) objects.push(trialObject(found));
  }
  const plan: TrialPlan = {
    laneId: row.laneId,
    head: row.head,
    peers: [...peers.values()].map(({ laneId, head }) => ({ laneId, head })),
    tasks: [...tasks.values()],
    objects,
    ...(main ? { main } : {}),
  };
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedConflictMerge:run'), {
    projectId,
    plan: JSON.stringify(plan),
  });
}

function trialObject(row: {
  digest: string;
  size: number;
  location?: string;
  r2Key?: string;
  r2Committed?: boolean;
  storageId?: Id<'_storage'>;
  pack?: { digest: string; size: number; offset: number };
}): TrialObject {
  return {
    digest: row.digest,
    size: row.size,
    ...(row.location ? { location: row.location } : {}),
    ...(row.r2Key ? { r2Key: row.r2Key } : {}),
    ...(row.r2Committed ? { r2Committed: true } : {}),
    ...(row.storageId ? { storageId: row.storageId } : {}),
    ...(row.pack ? { pack: row.pack } : {}),
  };
}

const rangeList = v.array(v.array(v.number()));
/** The trial merge's one write. Each pair is decided only while both saved heads are still the ones
 * merged; a newer save of either Lane plans its own merge and decides the pair again. */
export const record = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    head: v.string(),
    peers: v.array(v.object({ laneId: v.string(), head: v.string() })),
    mainHead: v.optional(v.string()),
    conflicts: v.array(
      v.object({
        peer: v.string(),
        path: v.string(),
        mine: rangeList,
        theirs: rangeList,
        reason: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const lane = (laneId: string) => laneRow(ctx, input.projectId, laneId);
    const me = await lane(input.laneId);
    if (!me?.open || me.head !== input.head) return null;
    const now = Date.now();
    const write = async (
      owner: Row,
      peer: string,
      peerHead: string,
      goal: string,
      found: {
        path: string;
        mine: number[][];
        theirs: number[][];
        reason: string;
      }[],
      swap: boolean,
    ) => {
      const existing = (
        await ctx.db
          .query('projectHostedConflictNotices')
          .withIndex('by_project_and_lane_and_open', q =>
            q.eq('projectId', input.projectId).eq('laneId', owner.laneId).eq('open', true),
          )
          .take(PEER_WINDOW)
      ).find(row => row.peer === peer);
      if (!found.length) {
        if (existing)
          await ctx.db.patch(existing._id, {
            open: false,
            clearedAt: now,
            cleared: 'save',
          });
        return;
      }
      const paths = found.slice(0, 10).map(item => ({
        path: item.path,
        mine: swap ? item.theirs : item.mine,
        theirs: swap ? item.mine : item.theirs,
        reason: item.reason,
      }));
      const value = {
        paths,
        laneHead: owner.head,
        peerHead,
        peerGoal: goal.slice(0, 160),
        updatedAt: now,
      };
      if (!owner.conflicted) await ctx.db.patch(owner._id, { conflicted: true });
      if (existing) await ctx.db.patch(existing._id, value);
      else
        await ctx.db.insert('projectHostedConflictNotices', {
          projectId: input.projectId,
          laneId: owner.laneId,
          peer,
          open: true,
          flaggedAt: now,
          laneStartedAt: owner._creationTime,
          ...value,
        });
    };
    for (const planned of input.peers) {
      const peer = await lane(planned.laneId);
      if (!peer?.open || peer.head !== planned.head) continue;
      const found = input.conflicts.filter(item => item.peer === planned.laneId);
      await write(me, planned.laneId, peer.head, peer.intent, found, false);
      await write(peer, me.laneId, me.head, me.intent, found, true);
    }
    if (input.mainHead !== undefined)
      await write(
        me,
        MAIN,
        input.mainHead,
        'main',
        input.conflicts.filter(item => item.peer === MAIN),
        false,
      );
    return null;
  },
});

/** First land of a Lane (the lead-time measurement): stamped on its open notices once. */
export async function markConflictLand(ctx: MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) {
  const rows = await ctx.db
    .query('projectHostedConflictNotices')
    .withIndex('by_project_and_lane_and_open', q =>
      q.eq('projectId', projectId).eq('laneId', laneId).eq('open', true),
    )
    .take(PEER_WINDOW);
  const now = Date.now();
  for (const row of rows)
    if (row.firstLandAt === undefined) await ctx.db.patch(row._id, { firstLandAt: now });
}

/** Open notices for a Lane (for its current head when given), as the overlap read returns them. */
export async function laneConflicts(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  head?: string,
) {
  const rows = await ctx.db
    .query('projectHostedConflictNotices')
    .withIndex('by_project_and_lane_and_open', q =>
      q.eq('projectId', projectId).eq('laneId', laneId).eq('open', true),
    )
    .take(20);
  return rows
    .filter(row => head === undefined || row.laneHead === head)
    .map(row => ({
      with: row.peer,
      goal: row.peerGoal,
      flaggedAt: new Date(row.flaggedAt).toISOString(),
      files: row.paths,
    }));
}

/** Notices read per summary: a week of dogfood is well under this. */
const SUMMARY_ROWS = 500;
/** Read-only lead-time summary for `metrics` (flip 4): notices flagged in the window, how each ended,
 * and the time from flag to the Lane's first land, with the Lane's age at the flag. One indexed range,
 * at most SUMMARY_ROWS rows of a few hundred bytes. */
export const summary = query({
  args: { projectId: v.id('hostedProjects'), from: v.number(), to: v.number() },
  returns: v.string(),
  handler: async (ctx, { projectId, from, to }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project metrics.');
      await accessibleProject(ctx, projectId, user.subject);
      const rows = await ctx.db
        .query('projectHostedConflictNotices')
        .withIndex('by_project_and_flagged', q =>
          q.eq('projectId', projectId).gte('flaggedAt', from).lt('flaggedAt', to),
        )
        .take(SUMMARY_ROWS + 1);
      const shown = rows.slice(0, SUMMARY_ROWS);
      const seconds = (ms: number) => Math.round(ms / 1000);
      const leads = shown
        .filter(row => row.firstLandAt !== undefined && row.firstLandAt >= row.flaggedAt)
        .map(row => seconds(row.firstLandAt! - row.flaggedAt))
        .sort((a, b) => a - b);
      return JSON.stringify({
        notices: shown.length,
        complete: rows.length <= SUMMARY_ROWS,
        withMain: shown.filter(row => row.peer === MAIN).length,
        open: shown.filter(row => row.open).length,
        cleared: {
          save: shown.filter(row => row.cleared === 'save').length,
          landed: shown.filter(row => row.cleared === 'landed').length,
          abandoned: shown.filter(row => row.cleared === 'abandoned').length,
        },
        leadToFirstLandSeconds: {
          count: leads.length,
          median: leads.length ? leads[Math.floor(leads.length / 2)]! : null,
          max: leads.at(-1) ?? null,
        },
        items: shown.slice(-50).map(row => ({
          laneId: row.laneId,
          with: row.peer,
          flaggedAt: new Date(row.flaggedAt).toISOString(),
          ...(row.firstLandAt !== undefined ? { firstLandAt: new Date(row.firstLandAt).toISOString() } : {}),
          laneAgeMinutes: Math.round((row.flaggedAt - row.laneStartedAt) / 60_000),
          files: row.paths.length,
          ...(row.cleared ? { cleared: row.cleared } : {}),
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** The web Lane view's open exact conflicts (flip 4). A reactive read of one indexed range of at most
 * 20 rows: it re-runs only when one of this Lane's notices changes, so an open idle tab costs nothing. */
export const forLane = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read Lane conflicts.');
      await accessibleProject(ctx, projectId, user.subject);
      return JSON.stringify(await laneConflicts(ctx, projectId, laneId));
    } catch (error) {
      return report(error);
    }
  },
});
