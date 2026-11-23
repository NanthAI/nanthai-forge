// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './cliServer';
import { invariant } from '../src/errors';
import { decodeFeedPosition, encodeFeedPosition } from '../src/feed-position';

type EventRow = Doc<'projectFeedEvents'>;
type Project = Id<'hostedProjects'>;
const committed = (row: EventRow) => row.commitTs as bigint;

export const feedArrivalAnchor = (ctx: QueryCtx) => encodeFeedPosition(ctx.meta.getSnapshotTs(), null);

/** Keep both the Lane and project selectors bounded, even if a full page shares a
 * transaction or most of its events do not pass the caller's filters. */
export async function readFeedArrivals(
  ctx: QueryCtx,
  projectId: Project,
  lanes: string[] | undefined,
  after: string,
  capacity: number,
) {
  const position = decodeFeedPosition(after);
  invariant(position, 'BAD_ARGUMENT', 'Invalid feed arrival cursor.');
  const { commit, id } = position;
  const limit = capacity + 1;
  const ranges = await Promise.all(
    (lanes ?? [undefined]).map(async lane => {
      if (lane) {
        const tied = id
          ? await ctx.db
              .query('projectFeedEvents')
              .withIndex('by_project_and_lane_and_commit_ts_and_id', q =>
                q.eq('projectId', projectId).eq('laneId', lane).eq('commitTs', commit).gt('id', id),
              )
              .take(limit)
          : [];
        if (tied.length === limit) return tied;
        return tied.concat(
          await ctx.db
            .query('projectFeedEvents')
            .withIndex('by_project_and_lane_and_commit_ts_and_id', q =>
              q.eq('projectId', projectId).eq('laneId', lane).gt('commitTs', commit),
            )
            .take(limit - tied.length),
        );
      }
      const tied = id
        ? await ctx.db
            .query('projectFeedEvents')
            .withIndex('by_project_and_commit_ts_and_id', q =>
              q.eq('projectId', projectId).eq('commitTs', commit).gt('id', id),
            )
            .take(limit)
        : [];
      if (tied.length === limit) return tied;
      return tied.concat(
        await ctx.db
          .query('projectFeedEvents')
          .withIndex('by_project_and_commit_ts_and_id', q =>
            q.eq('projectId', projectId).gt('commitTs', commit),
          )
          .take(limit - tied.length),
      );
    }),
  );
  const rows = ranges.flat().sort((a, b) => {
    const first = committed(a),
      second = committed(b);
    return first < second ? -1 : first > second ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const scanned = rows.slice(0, capacity);
  const last = scanned.at(-1);
  return {
    scanned,
    more: rows.length > capacity,
    after: last ? encodeFeedPosition(committed(last), last.id) : after,
  };
}
