// SPDX-License-Identifier: Apache-2.0
// Automatic file claims (Issue 9c8490a4, board Lane 4). The first-write hook records "touching
// <path>" for its Lane the first time a session writes a file the Lane has not saved, so other
// agents see unsaved edits. Claims are not notes: they never wake a wait, and they do not count
// against the note rate limits or the 5,000-note project cap. Their own bounds are below.
import { v } from 'convex/values';
import { mutation, type MutationCtx, type QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { recordCaller } from './projectHostedFrictionStore';
import { BOARD_CLEANUP_BATCH, BOARD_RETENTION_MS, boardStopped } from './projectBoardLimits';
import { assertBoardPaths } from '../src/board-text';
import { agentActor } from '../src/agent-slug';
import { canonicalPayload } from '../src/hosted-source-operation';
import { safeRelative } from '../src/safe-relative';
import { invariant } from '../src/errors';
import { report } from './errors';

type Ctx = QueryCtx | MutationCtx;
/** Live automatic claims one Lane may hold. A claim is freed when the Lane saves the path (removed
 * by its next claim) or closes; past the cap, new first writes are simply not claimed. */
export const BOARD_CLAIM_LANE_CAP = 30;
/** Paths in one claim call (the client batches first writes that arrive within a short window). */
export const BOARD_CLAIM_BATCH = 10;
/** Claim rows read per path on a first write (newest first; ≤2 shown). */
export const BOARD_CLAIM_PATH_SCAN = 6;

/** Automatic file claims are on unless the project policy turns them off
 * (`set-policy {"agentDefaults":{"autoClaim":false}}`). */
export const autoClaimOn = (project: Doc<'hostedProjects'> | null) =>
  project?.autonomyPolicy?.agentDefaults?.autoClaim !== false;

/** Path filter hook point. Hosted projects have no path-scoped read grants today: every member
 * who may read the board (write access) reads all source. If path grants arrive, a claim or note
 * path outside the viewer's grants must be hidden here (shown as "a restricted path"). */
export function boardPathVisible(_project: Doc<'hostedProjects'>, _viewer: string, _path: string) {
  return true;
}

/** Saved paths of one Lane, from its slim presence row (≤10 paths) when that list is complete,
 * else from its overlap row. Null when the Lane is not open. */
async function laneState(ctx: Ctx, projectId: Id<'hostedProjects'>, laneId: string) {
  const presence = await ctx.db
    .query('projectHostedPresence')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (presence && presence.pathCount <= presence.paths.length)
    return { actor: presence.actor, agent: presence.agent, saved: new Set(presence.paths) };
  const row = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (!row?.open) return null;
  let changes: { path?: unknown }[] = [];
  try {
    changes = JSON.parse(row.changes) as { path?: unknown }[];
  } catch {
    changes = [];
  }
  return {
    actor: row.actor,
    agent: row.agent,
    saved: new Set(changes.map(change => change.path).filter(path => typeof path === 'string')),
  };
}

/** One mutation per batch of new first-write paths. Reads: access (project + membership),
 * 3 switches, the Lane's presence row (overlap row only when presence is incomplete), its live
 * claims (≤ cap + 1 rows, ~0.15 KB each) and ≤10 expired rows. Writes: one ~0.15 KB row per new
 * unsaved path, deletes for the Lane's claims on paths it has since saved, ≤10 expired deletes.
 * A path already saved or already claimed writes nothing. */
export const claim = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    paths: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor, project } = await recordCaller(ctx, input.projectId, true);
      const projectId = input.projectId;
      invariant(
        input.paths.length >= 1 && input.paths.length <= BOARD_CLAIM_BATCH,
        'BAD_ARGUMENT',
        `Claim 1 to ${BOARD_CLAIM_BATCH} paths.`,
      );
      assertBoardPaths(input.paths);
      invariant(
        input.paths.every(path => safeRelative(path)),
        'BAD_ARGUMENT',
        'Claim repository-relative paths.',
      );
      if (!autoClaimOn(project)) return canonicalPayload({ status: 'off', claimed: 0 });
      if (await boardStopped(ctx, projectId, actor)) return canonicalPayload({ status: 'off', claimed: 0 });
      const lane = await laneState(ctx, projectId, input.laneId);
      if (!lane || lane.actor !== actor) return canonicalPayload({ status: 'closed', claimed: 0 });
      const now = Date.now();
      const mine = await ctx.db
        .query('projectBoardClaims')
        .withIndex('by_project_and_lane_and_path', q =>
          q.eq('projectId', projectId).eq('laneId', input.laneId),
        )
        .take(BOARD_CLAIM_LANE_CAP + 1);
      // Claims on paths this Lane has saved since are over: the saved-path overlap covers them.
      const held = new Set<string>();
      let live = 0;
      for (const row of mine)
        if (lane.saved.has(row.path) || row.expiresAt <= now) await ctx.db.delete(row._id);
        else {
          held.add(row.path);
          live++;
        }
      const expired = await ctx.db
        .query('projectBoardClaims')
        .withIndex('by_project_and_expiry', q => q.eq('projectId', projectId).lt('expiresAt', now))
        .take(BOARD_CLEANUP_BATCH);
      for (const row of expired) if (row.laneId !== input.laneId) await ctx.db.delete(row._id);
      let claimed = 0,
        capped = 0;
      for (const path of new Set(input.paths)) {
        if (lane.saved.has(path) || held.has(path)) continue;
        if (live >= BOARD_CLAIM_LANE_CAP) {
          capped++;
          continue;
        }
        await ctx.db.insert('projectBoardClaims', {
          projectId,
          laneId: input.laneId,
          path,
          author: actor,
          ...(lane.agent ? { agent: lane.agent } : {}),
          at: now,
          expiresAt: now + BOARD_RETENTION_MS,
        });
        held.add(path);
        live++;
        claimed++;
      }
      return canonicalPayload({ status: 'ok', claimed, ...(capped ? { capped } : {}), live });
    } catch (error) {
      return report(error);
    }
  },
});

/** Open-Lane view the overlap read already holds in memory (its peer window). */
export type ClaimPeers = (laneId: string) => { open: boolean; saved: Set<string> } | undefined;

/** Automatic claims by other Lanes on one path, newest first, ≤2. A claim is hidden once its Lane
 * saved the path (the saved-path overlap shows it then) or closed. Lanes outside the caller's
 * peer window are checked with one slim presence read each. */
export async function readAutoClaims(
  ctx: Ctx,
  input: {
    project: Doc<'hostedProjects'>;
    viewer: string;
    laneId: string;
    path: string;
    now: number;
    peers?: ClaimPeers;
  },
) {
  if (!autoClaimOn(input.project) || !boardPathVisible(input.project, input.viewer, input.path)) return [];
  const rows = await ctx.db
    .query('projectBoardClaims')
    .withIndex('by_project_and_path_and_at', q => q.eq('projectId', input.project._id).eq('path', input.path))
    .order('desc')
    .take(BOARD_CLAIM_PATH_SCAN);
  const shown: { author: string; fromLaneId: string; at: number }[] = [];
  for (const row of rows) {
    if (shown.length >= 2) break;
    if (row.laneId === input.laneId || row.expiresAt <= input.now) continue;
    const peer = input.peers?.(row.laneId) ?? (await laneState(ctx, input.project._id, row.laneId));
    if (!peer || ('open' in peer && !peer.open) || peer.saved.has(row.path)) continue;
    shown.push({ author: agentActor(row.author, row.agent), fromLaneId: row.laneId, at: row.at });
  }
  return shown;
}

/** Whether the first-write hook should send a claim for its path: `send` only for a write member's
 * open Lane, policy on, board on, the path not saved in the Lane and not already claimed by it
 * (one point read). Paths already saved or claimed cost no call. */
export async function claimDecision(
  ctx: Ctx,
  input: {
    project: Doc<'hostedProjects'>;
    viewer: string;
    laneId: string;
    open: boolean;
    path: string;
    saved: Set<string>;
  },
): Promise<'send' | 'saved' | 'held' | 'off' | 'closed'> {
  if (!autoClaimOn(input.project)) return 'off';
  if (!input.open) return 'closed';
  if (input.saved.has(input.path)) return 'saved';
  const row = await ctx.db
    .query('projectBoardClaims')
    .withIndex('by_project_and_lane_and_path', q =>
      q.eq('projectId', input.project._id).eq('laneId', input.laneId).eq('path', input.path),
    )
    .unique();
  return row && row.expiresAt > Date.now() ? 'held' : 'send';
}
