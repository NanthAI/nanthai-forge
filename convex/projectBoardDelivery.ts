// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { boardStopped } from './projectBoardLimits';
import { boardPathVisible, claimDecision, readAutoClaims, type ClaimPeers } from './projectBoardClaims';
import { agentActor } from '../src/agent-slug';
import { laneConflicts } from './projectHostedConflicts';
import { hasWriteRole } from './projectRole';

type Ctx = QueryCtx | MutationCtx;
/** A message as returned. `author` is an auth subject here (`subject/slug` for an agent session,
 * c29d0780); the public function wrapper maps it to a Forge handle (`handle/slug`) for members with
 * write access and removes it for anyone else. */
export function boardMessageView(row: Doc<'projectBoardMessages'>) {
  return {
    id: row.id,
    author: agentActor(row.author, row.agent),
    ...(row.fromLaneId ? { fromLaneId: row.fromLaneId } : {}),
    target: row.targetKey,
    text: row.body,
    ...(row.paths?.length ? { paths: row.paths } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    at: row.at,
    // Only on a note an explicit read returns after it was withdrawn (friction 9d7bd94f).
    ...(row.resolvedAt && row.resolvedBy
      ? {
          resolved: {
            by: agentActor(row.resolvedBy, row.resolvedAgent),
            at: row.resolvedAt,
            ...(row.resolvedText ? { text: row.resolvedText } : {}),
          },
        }
      : {}),
  };
}

/** Board content is for members with write access only (owner and contributors). Hosted projects
 * have no path-scoped read grants: every such member reads all source, so paths need no masking. */
async function boardWriterProject(ctx: Ctx, projectId: Id<'hostedProjects'>, viewer: string) {
  const project = await ctx.db.get(projectId);
  if (!project || project.removal) return null;
  return (await hasWriteRole(ctx, project, viewer)) ? project : null;
}

/** Unread notes for one Lane: its own inbox, its Issue's and the project's. Three point reads;
 * message rows are read only for a target whose latestAt moved past the cursor. Oldest first, so
 * a cursor at the last delivered note never skips one. The caller's own Lane's notes are left out.
 * Resolved notes are skipped through the index (never read, so they cannot fill a page or stall
 * the cursor) unless `includeResolved` (an explicit `board {all:true}`). */
export async function boardInbox(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId?: string;
    intentId?: string;
    after: number;
    laneAfter?: number;
    projectAfter?: number;
    limit: number;
    order: 'asc' | 'desc';
    includeResolved?: boolean;
    /** Live waits only consume directed notes; ordinary board reads keep all three inboxes. */
    laneOnly?: boolean;
  },
) {
  const keys = [
    ...(input.laneId ? [`lane:${input.laneId}`] : []),
    ...(input.intentId && !input.laneOnly ? [`issue:${input.intentId}`] : []),
    ...(input.laneOnly ? [] : ['project']),
  ];
  const inboxes = await Promise.all(
    keys.map(key =>
      ctx.db
        .query('projectBoardInboxes')
        .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', key))
        .unique(),
    ),
  );
  const after = (key: string) => {
    if (key === 'project') return Math.max(input.after, input.projectAfter ?? 0);
    if (key.startsWith('lane:')) return Math.max(input.after, input.laneAfter ?? 0);
    return input.after;
  };
  const hot = inboxes.filter(row => row !== null && row.latestAt > after(row.key));
  const pages = await Promise.all(
    hot.map(row => {
      const query = input.includeResolved
        ? ctx.db
            .query('projectBoardMessages')
            .withIndex('by_project_and_target_and_at', q =>
              q.eq('projectId', input.projectId).eq('targetKey', row!.key).gt('at', after(row!.key)),
            )
        : ctx.db
            .query('projectBoardMessages')
            .withIndex('by_project_and_target_and_resolved_and_at', q =>
              q
                .eq('projectId', input.projectId)
                .eq('targetKey', row!.key)
                .eq('resolvedAt', undefined)
                .gt('at', after(row!.key)),
            );
      // Exclude own notes before truncating: a full page of them must not let the
      // cursor jump to latestAt past somebody else's unread note.
      return (input.laneId ? query.filter(q => q.neq(q.field('fromLaneId'), input.laneId)) : query)
        .order(input.order)
        .take(input.limit + 1);
    }),
  );
  const sign = input.order === 'asc' ? 1 : -1;
  const rows = pages.flat().sort((a, b) => sign * (a.at - b.at));
  const shown = rows.slice(0, input.limit);
  return {
    messages: shown.map(boardMessageView),
    /** At least this many more unread notes (a lower bound: each target returns limit + 1 eligible rows). */
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
    .filter(row => !row.resolvedAt && row.fromLaneId !== input.laneId && row.paths?.includes(input.path))
    .slice(0, 2)
    .map(boardMessageView);
}

/** The overlap read's board field (Lane actions): at most 2 notes, absent when nothing is new.
 * With `path` (the first-write hook) it returns only claims on that path and skips inbox reads
 * (unread notes ride on command replies and wait, never on a hook; Item f3495abe). Wire fields
 * `messages: [], more: 0, cursor: input.after` stay present so older CLIs keep parsing claims
 * without advancing their local cursor. */
export async function boardDelivery(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    viewer: string;
    laneId: string;
    intentId: string;
    after: number;
    laneAfter?: number;
    projectAfter?: number;
    path?: string;
    /** Skip unread inbox reads (default true when `path` is set: first-write hook). */
    skipInbox?: boolean;
    /** First-write hook with feature board-claims: decide whether to send an automatic claim, and
     * list other Lanes' automatic claims on the path. `lane` is the caller's Lane as already read. */
    autoClaim?: { open: boolean; saved: Set<string>; peers?: ClaimPeers };
  },
) {
  const project = await boardWriterProject(ctx, input.projectId, input.viewer);
  if (!project) return undefined;
  if (await boardStopped(ctx, input.projectId)) return undefined;
  const { path, skipInbox = Boolean(path), autoClaim, ...rest } = input;
  const inbox = skipInbox
    ? { messages: [], more: 0, cursor: input.after }
    : await boardInbox(ctx, { ...rest, limit: 2, order: 'asc' });
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
 * cursor, directed notes (≤2) are read once, cursor-safe. Project and Issue notes remain
 * available to ordinary board reads and cannot starve a directed note behind their backlog. */
export async function boardWake(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    viewer: string;
    laneId: string;
    after: number;
  },
) {
  const project = await boardWriterProject(ctx, input.projectId, input.viewer);
  if (!project) return undefined;
  const inbox = await ctx.db
    .query('projectBoardInboxes')
    .withIndex('by_project_and_key', q =>
      q.eq('projectId', input.projectId).eq('key', `lane:${input.laneId}`),
    )
    .unique();
  if (!inbox || inbox.latestAt <= input.after) return undefined;
  const conflicts = await laneConflicts(ctx, input.projectId, input.laneId, undefined, input.after, project);
  // Exact source conflicts remain deliverable when member-written board notes are switched off.
  if (await boardStopped(ctx, input.projectId))
    return conflicts.length ? { messages: [], more: 0, cursor: inbox.latestAt, conflicts } : undefined;
  const delivered = await boardInbox(ctx, {
    projectId: input.projectId,
    laneId: input.laneId,
    laneOnly: true,
    after: input.after,
    limit: 2,
    order: 'asc',
  });
  return delivered.messages.length || conflicts.length
    ? { ...delivered, ...(conflicts.length ? { conflicts } : {}) }
    : undefined;
}
