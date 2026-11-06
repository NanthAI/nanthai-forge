// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { boardStopped } from './projectBoardLimits';
import { boardPathVisible, claimDecision, readAutoClaims, type ClaimPeers } from './projectBoardClaims';

type Ctx = QueryCtx | MutationCtx;
/** A message as returned. `author` is an auth subject here; the public function wrapper maps it to
 * a Forge handle for members with write access and removes it for anyone else. */
export function boardMessageView(row: Doc<'projectBoardMessages'>) {
  return {
    id: row.id,
    author: row.author,
    ...(row.fromLaneId ? { fromLaneId: row.fromLaneId } : {}),
    target: row.targetKey,
    text: row.body,
    ...(row.paths?.length ? { paths: row.paths } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    at: row.at,
  };
}

/** Board content is for members with write access only (owner and contributors). Hosted projects
 * have no path-scoped read grants: every such member reads all source, so paths need no masking. */
export async function boardWriter(ctx: Ctx, projectId: Id<'hostedProjects'>, viewer: string) {
  return (await boardWriterProject(ctx, projectId, viewer)) !== null;
}
/** The project row when `viewer` may use the board, else null. */
export async function boardWriterProject(ctx: Ctx, projectId: Id<'hostedProjects'>, viewer: string) {
  const project = await ctx.db.get(projectId);
  if (!project || project.removal) return null;
  if (project.owner === viewer) return project;
  const contributor = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', viewer))
    .unique();
  return contributor !== null ? project : null;
}

/** Unread notes for one Lane: its own inbox, its Issue's and the project's. Three point reads;
 * message rows are read only for a target whose latestAt moved past the cursor. Oldest first, so
 * a cursor at the last delivered note never skips one. The caller's own Lane's notes are left out. */
export async function boardInbox(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId?: string;
    intentId?: string;
    after: number;
    limit: number;
    order: 'asc' | 'desc';
  },
) {
  const keys = [
    ...(input.laneId ? [`lane:${input.laneId}`] : []),
    ...(input.intentId ? [`issue:${input.intentId}`] : []),
    'project',
  ];
  const inboxes = await Promise.all(
    keys.map(key =>
      ctx.db
        .query('projectBoardInboxes')
        .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', key))
        .unique(),
    ),
  );
  const hot = inboxes.filter(row => row !== null && row.latestAt > input.after);
  const pages = await Promise.all(
    hot.map(row =>
      ctx.db
        .query('projectBoardMessages')
        .withIndex('by_project_and_target_and_at', q =>
          q.eq('projectId', input.projectId).eq('targetKey', row!.key).gt('at', input.after),
        )
        .order(input.order)
        .take(input.limit + 1),
    ),
  );
  const sign = input.order === 'asc' ? 1 : -1;
  const rows = pages
    .flat()
    .filter(row => !input.laneId || row.fromLaneId !== input.laneId)
    .sort((a, b) => sign * (a.at - b.at));
  const shown = rows.slice(0, input.limit);
  return {
    messages: shown.map(boardMessageView),
    /** At least this many more unread notes (a lower bound: each target reads limit + 1 rows). */
    more: Math.max(0, rows.length - shown.length),
    /** Where the caller's cursor goes: the last note shown oldest-first, else the newest seen. */
    cursor:
      input.order === 'asc' && rows.length > shown.length
        ? (shown.at(-1)?.at ?? input.after)
        : Math.max(input.after, ...inboxes.map(row => row?.latestAt ?? 0)),
  };
}

/** Newest notes scanned for claims on one path (first-write hook). Notes carry ≤10 paths. */
export const BOARD_CLAIM_SCAN = 20;
/** Claims on `path`: live notes from other Lanes naming that path (paths are repository files).
 * Read only when the project has live notes; then the newest BOARD_CLAIM_SCAN rows through the
 * expiry index (expiry is post time + retention, so newest expiry is newest post). ≤2 returned. */
export async function boardClaims(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId: string;
    path: string;
    now: number;
  },
) {
  const counter = await ctx.db
    .query('projectBoardProjects')
    .withIndex('by_project', q => q.eq('projectId', input.projectId))
    .unique();
  if (!counter?.live) return [];
  const rows = await ctx.db
    .query('projectBoardMessages')
    .withIndex('by_project_and_expiry', q => q.eq('projectId', input.projectId).gt('expiresAt', input.now))
    .order('desc')
    .take(BOARD_CLAIM_SCAN);
  return rows
    .filter(row => row.fromLaneId !== input.laneId && row.paths?.includes(input.path))
    .slice(0, 2)
    .map(boardMessageView);
}

/** The overlap read's board field (Lane actions): at most 2 notes, absent when nothing is new.
 * With `path` (the first-write hook) it also lists claims on that path. No access, board off or
 * nothing new all return undefined: nothing is added to the reply. */
export async function boardDelivery(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    viewer: string;
    laneId: string;
    intentId: string;
    after: number;
    path?: string;
    /** First-write hook with feature board-claims: decide whether to send an automatic claim, and
     * list other Lanes' automatic claims on the path. `lane` is the caller's Lane as already read. */
    autoClaim?: { open: boolean; saved: Set<string>; peers?: ClaimPeers };
  },
) {
  const project = await boardWriterProject(ctx, input.projectId, input.viewer);
  if (!project) return undefined;
  if (await boardStopped(ctx, input.projectId)) return undefined;
  const { path, autoClaim, ...rest } = input;
  const inbox = await boardInbox(ctx, { ...rest, limit: 2, order: 'asc' });
  const now = Date.now();
  const claims =
    path && boardPathVisible(project, input.viewer, path)
      ? await boardClaims(ctx, { projectId: input.projectId, laneId: input.laneId, path, now })
      : [];
  const touching =
    path && autoClaim
      ? await readAutoClaims(ctx, {
          project,
          viewer: input.viewer,
          laneId: input.laneId,
          path,
          now,
          ...(autoClaim.peers ? { peers: autoClaim.peers } : {}),
        })
      : [];
  const claim =
    path && autoClaim
      ? await claimDecision(ctx, {
          project,
          viewer: input.viewer,
          laneId: input.laneId,
          open: autoClaim.open,
          path,
          saved: autoClaim.saved,
        })
      : undefined;
  if (!inbox.messages.length && !claims.length && !touching.length && claim !== 'send') return undefined;
  return {
    ...inbox,
    ...(claims.length ? { claims } : {}),
    ...(touching.length ? { touching } : {}),
    ...(claim === 'send' ? { claim } : {}),
  };
}

/** Wait delivery (live subscription): watches ONLY the Lane's own inbox row, so a post elsewhere
 * (Issue, project, another Lane) never re-runs this Lane's wait. When that row moved past the
 * cursor, the full delivery (Lane, Issue and project notes, ≤2) is read once, cursor-safe. */
export async function boardWake(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    viewer: string;
    laneId: string;
    after: number;
  },
) {
  if (!(await boardWriter(ctx, input.projectId, input.viewer))) return undefined;
  const inbox = await ctx.db
    .query('projectBoardInboxes')
    .withIndex('by_project_and_key', q =>
      q.eq('projectId', input.projectId).eq('key', `lane:${input.laneId}`),
    )
    .unique();
  if (!inbox || inbox.latestAt <= input.after) return undefined;
  if (await boardStopped(ctx, input.projectId)) return undefined;
  const lane = await ctx.db
    .query('projectHostedPresence')
    .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', input.laneId))
    .unique();
  const delivered = await boardInbox(ctx, {
    projectId: input.projectId,
    laneId: input.laneId,
    ...(lane ? { intentId: lane.intentId } : {}),
    after: input.after,
    limit: 2,
    order: 'asc',
  });
  return delivered.messages.length ? delivered : undefined;
}
