// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { ForgeError, invariant } from '../src/errors';
import { QUEUE_ROOM_MAX, queueRoomCount, type QueueStatusKey } from '../src/hosted-queue-status';

/**
 * Land when the queue has room (ad80e037, `land {maxChecks:N}`): a submission that names N
 * is admitted only while the queue holds fewer than N checks (at most N once it joins), judged inside the submitting
 * mutation, so a builder's queue read and its submit can no longer race past a project's check
 * cap (two submits that both see room conflict and Convex re-runs one, which then sees the other).
 *
 * Checks = the queue's service groups (one check each: a batch is one group), held entries left
 * out, plus landings still preparing their source (each counted as one: it joins the queue next).
 * Reads: the compact queue directory pages (at most QUEUE_ROOM_PAGES, ordering metadata only) and
 * at most N preparing rows. The same read answers the `room` query a waiting land subscribes to;
 * the directory pages change only when order, phase or holds change (never on clock ticks), so a
 * waiting land re-runs it only when the queue or a preparing landing changed (a preparing row's
 * stall re-arm also re-runs it, cheaply). With 8 or more pages it also reads the queue row, which
 * changes on clock ticks too. No polling, timer or idle work: it runs only while a land waits.
 *
 * Switch FORGE_QUEUE_LAND_WHEN_ROOM (off by default; queue-regression guard, Items 5e3c3a3c and
 * d4289a6a): off, a submission naming maxChecks is refused before anything is written.
 */
export const landWhenRoom = () => process.env.FORGE_QUEUE_LAND_WHEN_ROOM === '1';
/** Directory pages read: 128 sequence numbers each, so the live queue sits on the last one or two. */
const QUEUE_ROOM_PAGES = 8;

export async function queueChecks(ctx: QueryCtx, projectId: Id<'hostedProjects'>, limit: number) {
  const pages = await ctx.db
    .query('projectHostedLandingQueueStatus')
    .withIndex('by_project_and_page', q => q.eq('projectId', projectId))
    .order('desc')
    .take(QUEUE_ROOM_PAGES);
  const keys = pages.flatMap(page => JSON.parse(page.value) as QueueStatusKey[]);
  const preparing = await ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_preparing', q => q.eq('projectId', projectId).eq('preparing', true))
    .take(limit);
  const room = queueRoomCount(keys, preparing.length);
  if (pages.length < QUEUE_ROOM_PAGES) return room;
  // Held entries keep old pages alive and a released entry keeps its old sequence, so a checking
  // entry can sit past the pages read (review aeec44a8). Then the queue row's exact group count
  // (held entries out) decides; unknown counts as full, so the check never fails open.
  const queue = await ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', projectId).eq('channel', 'main'))
    .unique();
  const groups = Math.max(room.groups, queue?.status?.groups ?? QUEUE_ROOM_MAX);
  return { ...room, groups, checks: groups + room.preparing };
}

/** Inside the submitting mutation, for a new submission only (replays and joins return before). */
export async function requireQueueRoom(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  maxChecks: number | undefined,
) {
  if (maxChecks === undefined) return;
  invariant(
    landWhenRoom(),
    'HOSTED_ACTION_UNSUPPORTED',
    'maxChecks is off on this server (switch FORGE_QUEUE_LAND_WHEN_ROOM). Nothing was submitted; land without it.',
  );
  invariant(
    Number.isInteger(maxChecks) && maxChecks >= 1 && maxChecks <= QUEUE_ROOM_MAX,
    'BAD_ARGUMENT',
    `maxChecks is a whole number from 1 to ${QUEUE_ROOM_MAX}.`,
  );
  const room = await queueChecks(ctx, projectId, maxChecks);
  if (room.checks >= maxChecks)
    throw new ForgeError(
      'WORK_BUSY',
      `No queue room: ${room.checks} checks are running or waiting (${room.groups} in the queue, ${room.preparing} preparing) so maxChecks ${maxChecks} admits no more. Nothing was submitted.`,
    );
}

/** What a land waiting for room subscribes to: the same count the submit judges. */
export const room = query({
  args: { projectId: v.id('hostedProjects'), limit: v.number() },
  returns: v.string(),
  handler: async (ctx, { projectId, limit }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the landing queue.');
      await accessibleProject(ctx, projectId, user.subject);
      const bound = Number.isFinite(limit) ? Math.max(1, Math.min(QUEUE_ROOM_MAX, Math.floor(limit))) : 1;
      return JSON.stringify(await queueChecks(ctx, projectId, bound));
    } catch (error) {
      return report(error);
    }
  },
});
