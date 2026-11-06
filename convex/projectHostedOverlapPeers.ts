// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { overlapPeerOf, type OverlapPeerSource } from '../src/hosted-overlap-peer';

/** Peer window of every overlap read; one more row says the window is full. */
export const PEER_WINDOW = 51;

type Row = Doc<'projectHostedOverlapLanes'>;
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** Keeps the slim peer row equal to its overlap row. Every write of an overlap row calls this with the
 * row as stored (insert, replace and patch alike); no other file may write the overlap table
 * (`tests/hosted-overlap-peers.test.mjs` enforces it). Costs one indexed read of the ~1 KB peer row and
 * a write only when it differs. */
export async function syncOverlapPeer(
  ctx: MutationCtx,
  row: OverlapPeerSource<Id<'hostedProjects'>, Id<'projectHostedLifecyclePlans'>>,
) {
  const value = overlapPeerOf(row);
  const old = await ctx.db
    .query('projectHostedOverlapPeers')
    .withIndex('by_project_and_lane', q => q.eq('projectId', row.projectId).eq('laneId', row.laneId))
    .unique();
  if (!old) await ctx.db.insert('projectHostedOverlapPeers', value);
  else {
    const stored = Object.entries(old).filter(([key]) => key !== '_id' && key !== '_creationTime');
    if (stable(Object.fromEntries(stored)) !== stable(value)) await ctx.db.replace(old._id, value);
  }
}

/** The only patch of an overlap row: patches it, then re-derives its slim peer row from the result. */
export async function patchOverlapRow(ctx: MutationCtx, row: Row, patch: Partial<Omit<Row, '_id'>>) {
  await ctx.db.patch(row._id, patch);
  await syncOverlapPeer(ctx, { ...row, ...patch });
}

/** Newest live open peers, at most `PEER_WINDOW`: the slim twin of `liveOpenOverlapLanes`, same indexed
 * ranges and order over the same fields, a fraction of the bytes. */
export async function liveOpenOverlapPeers(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  cutoff: number | null,
) {
  if (cutoff === null)
    return ctx.db
      .query('projectHostedOverlapPeers')
      .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
      .order('desc')
      .take(PEER_WINDOW);
  const [live, legacy] = await Promise.all([
    ctx.db
      .query('projectHostedOverlapPeers')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).gt('lastActivityAt', cutoff),
      )
      .order('desc')
      .take(PEER_WINDOW),
    ctx.db
      .query('projectHostedOverlapPeers')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).eq('lastActivityAt', undefined),
      )
      .order('desc')
      .take(PEER_WINDOW),
  ]);
  const activity = (row: Doc<'projectHostedOverlapPeers'>) =>
    row.lastActivityAt ?? row.presenceAt ?? Infinity;
  return [...live, ...legacy.filter(row => activity(row) > cutoff)]
    .sort((a, b) => (activity(a) === activity(b) ? 0 : activity(b) > activity(a) ? 1 : -1))
    .slice(0, PEER_WINDOW);
}
