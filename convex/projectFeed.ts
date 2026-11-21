// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { query, type QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { finishReadReader } from './projectFinishReadReader';
import { feedEventView, type StoredFeedEvent } from '../src/feed-event';
import { invariant } from '../src/errors';
import { feedEventViewValidator, feedKind } from './projectFeedFields';
import { feedQueueEvent } from './projectFeedQueue';
import { report } from './errors';

const pageSize = 33;
const laneScopeMax = 32;
const laneId = z.uuid();
const position = z.tuple([z.number().int().nonnegative(), z.string().min(1).max(200)]);
type Position = z.infer<typeof position>;
type EventRow = Doc<'projectFeedEvents'>;
type Project = Id<'hostedProjects'>;

async function feedAccess(ctx: QueryCtx, projectId: Project) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the project feed.');
  await activeProject(finishReadReader(ctx), projectId, user.subject);
  return user.subject;
}

/** The continuation is a scan position, including rows dropped by mine/kinds. Each range
 * reads at most one page plus a lookahead, even when no row matches the selected filters. */
async function readRange(
  ctx: QueryCtx,
  projectId: Project,
  lane: string | undefined,
  since: number,
  after: Position | undefined,
) {
  if (lane) {
    const tied = after
      ? await ctx.db
          .query('projectFeedEvents')
          .withIndex('by_project_and_lane_and_at_and_id', q =>
            q.eq('projectId', projectId).eq('laneId', lane).eq('at', after[0]).gt('id', after[1]),
          )
          .take(pageSize + 1)
      : [];
    if (tied.length > pageSize) return tied;
    return tied.concat(
      await ctx.db
        .query('projectFeedEvents')
        .withIndex('by_project_and_lane_and_at_and_id', q => {
          const range = q.eq('projectId', projectId).eq('laneId', lane);
          return after ? range.gt('at', after[0]) : range.gte('at', since);
        })
        .take(pageSize + 1 - tied.length),
    );
  }
  const tied = after
    ? await ctx.db
        .query('projectFeedEvents')
        .withIndex('by_project_and_at_and_id', q =>
          q.eq('projectId', projectId).eq('at', after[0]).gt('id', after[1]),
        )
        .take(pageSize + 1)
    : [];
  if (tied.length > pageSize) return tied;
  return tied.concat(
    await ctx.db
      .query('projectFeedEvents')
      .withIndex('by_project_and_at_and_id', q => {
        const range = q.eq('projectId', projectId);
        return after ? range.gt('at', after[0]) : range.gte('at', since);
      })
      .take(pageSize + 1 - tied.length),
  );
}

function decodeCursor(cursor: string, since: number) {
  let decoded: unknown;
  if (cursor.length <= 512) {
    try {
      decoded = JSON.parse(atob(cursor));
    } catch {
      // A malformed token gets the same structured error as an out-of-range token.
    }
  }
  const parsed = position.safeParse(decoded);
  invariant(parsed.success && parsed.data[0] >= since, 'BAD_ARGUMENT', 'Invalid feed continuation.');
  return parsed.data;
}

const order = (a: Pick<EventRow, 'at' | 'id'>, b: Pick<EventRow, 'at' | 'id'>) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    since: v.number(),
    lanes: v.optional(v.array(v.string())),
    project: v.optional(v.literal(true)),
    mine: v.optional(v.literal(true)),
    kinds: v.optional(v.array(feedKind)),
    queue: v.optional(v.object({ laneId: v.string() })),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    events: v.array(feedEventViewValidator),
    more: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    try {
      const actor = await feedAccess(ctx, input.projectId);
      invariant(
        Number.isSafeInteger(input.since) && input.since >= 0,
        'BAD_ARGUMENT',
        'since is a millisecond timestamp.',
      );
      invariant(Boolean(input.project) !== Boolean(input.lanes), 'BAD_ARGUMENT', 'Choose project or lanes.');
      invariant(!input.mine || input.project, 'BAD_ARGUMENT', 'mine requires project scope.');
      const lanes = input.lanes && [...new Set(input.lanes)];
      invariant(
        !lanes ||
          (input.lanes!.length <= laneScopeMax &&
            lanes.length > 0 &&
            lanes.every(id => laneId.safeParse(id).success)),
        'BAD_ARGUMENT',
        'Choose 1 to 32 Lane ids.',
      );
      invariant(
        !input.queue ||
          (laneId.safeParse(input.queue.laneId).success && (!lanes || lanes.includes(input.queue.laneId))),
        'BAD_ARGUMENT',
        'The queue Lane must be in the feed scope.',
      );
      const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor, input.since);
      const kinds = input.kinds && new Set(input.kinds);
      const queue =
        input.queue && !after && (!kinds || kinds.has('queue.moved'))
          ? await feedQueueEvent(ctx, input.projectId, input.queue.laneId, input.mine ? actor : undefined)
          : null;
      const ranges = await Promise.all(
        (lanes ?? [undefined]).map(lane => readRange(ctx, input.projectId, lane, input.since, after)),
      );
      const rows = ranges.flat().sort(order);
      const capacity = pageSize - (queue ? 1 : 0);
      const scan = rows.slice(0, capacity);
      const events = scan
        .filter(row => (!input.mine || row.actor === actor) && (!kinds || kinds.has(row.kind)))
        .map(row => feedEventView(row as EventRow & StoredFeedEvent));
      if (queue) events.push(queue);
      const more = rows.length > capacity;
      const last = scan.at(-1);
      return {
        events: events.sort(order),
        more,
        cursor: more && last ? btoa(JSON.stringify([last.at, last.id])) : null,
      };
    } catch (error) {
      return report(error);
    }
  },
});
