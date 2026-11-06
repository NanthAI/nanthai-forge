// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject, activeProject } from './projectAuthority';
import { readHostedPresence } from './projectHostedPresence';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedOverlapAdvice } from '../src/hosted-overlap';
import { invariant } from '../src/errors';
import { report } from './errors';
import { safeRelative } from '../src/safe-relative';
import { boardDelivery } from './projectBoardDelivery';

const savedPaths = (changes: string) => {
  try {
    return (JSON.parse(changes) as { path?: unknown }[])
      .map(change => change.path)
      .filter((path): path is string => typeof path === 'string');
  } catch {
    return [];
  }
};

/** One finite agent read. No source objects, Work hydration, scheduler or subscription. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    paths: v.optional(v.literal(true)),
    path: v.optional(v.string()),
    detail: v.optional(v.boolean()),
    /** Notices to list, 5 by default; ack asks for more so one read answers a large inbox. */
    items: v.optional(v.number()),
    /** Presence (capability presenceVersion): related open Lanes. `since` is the previous reply's `at`. */
    presence: v.optional(v.object({ since: v.optional(v.number()) })),
    /** Board notes newer than the client's local cursor (ms); members with write access only.
     * With `path` (first-write hook) the field also lists claims on that path. With `claim`
     * (feature board-claims) it also lists automatic claims on the path (`touching`) and says
     * `claim: 'send'` when the hook should record its own. */
    board: v.optional(v.object({ after: v.number(), claim: v.optional(v.literal(true)) })),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId, paths, items, path, detail, presence, board: boardCursor }) => {
    try {
      invariant(path === undefined || safeRelative(path), 'BAD_ARGUMENT', 'Select a repository path.');
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted overlaps.');
      await accessibleProject(ctx, projectId, user.subject);
      const record = await readHostedRecord(ctx, {
        projectId,
        actor: user.subject,
        kind: 'lane',
        key: laneId,
      });
      invariant(record, 'NOT_FOUND', 'Hosted Lane not found on this project.');
      const lane = hostedLaneSchema.parse(JSON.parse(record.value));
      const [mine, main, latest] = await Promise.all([
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .unique(),
        hostedStartMain(ctx, projectId),
        ctx.db
          .query('projectHostedOverlapMain')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .unique(),
      ]);
      let baseSequence = mine?.baseSequence ?? null;
      if (baseSequence === null) {
        if (lane.base.receiptId === main.receipt.id) baseSequence = main.sourceRevision;
        else {
          const base = await ctx.db
            .query('projectHostedAcceptances')
            .withIndex('by_project_and_receipt', q =>
              q.eq('projectId', projectId).eq('receiptId', lane.base.receiptId),
            )
            .unique();
          baseSequence = base?.sequence ?? null;
        }
      }
      const focus =
        mine && mine.head === lane.head && mine.baseHead === lane.base.head
          ? { ...mine, baseSequence, ...(lane.resolution ? { resolutionLeft: lane.resolution.left } : {}) }
          : {
              laneId,
              intentId: lane.intentId,
              actor: lane.actor,
              intent: lane.intentId,
              head: lane.head,
              baseHead: lane.base.head,
              ...(lane.resolution ? { resolutionLeft: lane.resolution.left } : {}),
              baseSequence,
              open: lane.state === 'active',
              changes: '[]',
              complete: lane.head === lane.base.head,
            };
      // A Lane with no saved path changes cannot overlap anything: skip the peer, head and answer
      // reads (the bulk of this query's I/O) instead of scanning every open Lane for nothing.
      const idle = !path && focus.complete && focus.changes === '[]';
      const readPeers = () =>
        Promise.all([
          ctx.db
            .query('projectHostedOverlapLanes')
            .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
            .order('desc')
            .take(51),
          ctx.db
            .query('projectHostedOverlapAcks')
            .withIndex('by_project_and_lane_and_notice', q =>
              q.eq('projectId', projectId).eq('laneId', laneId),
            )
            .take(101),
          ctx.db
            .query('projectHostedRecordHeads')
            .withIndex('by_project_and_kind_and_status', q =>
              q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
            )
            .order('desc')
            .take(51),
        ]);
      const [peers, acks, headers] = idle
        ? ([[], [], []] as Awaited<ReturnType<typeof readPeers>>)
        : await readPeers();
      const versions = new Map(headers.map(header => [header.key, header.version]));
      // Newest-first windows hold current work, but retained stale active Lanes can still push
      // a live peer out of the 51-row window (2026-10-30: 125 active heads hid every peer).
      // An exact indexed head read keeps such a peer's currency check correct.
      for (const peer of peers.slice(0, 50))
        if (!versions.has(peer.laneId)) {
          const head = await ctx.db
            .query('projectHostedRecordHeads')
            .withIndex('by_project_and_kind_and_key', q =>
              q.eq('projectId', projectId).eq('kind', 'lane').eq('key', peer.laneId),
            )
            .unique();
          if (head?.status === 'active') versions.set(peer.laneId, head.version);
        }
      const plans = new Map();
      for (const peer of peers)
        if (peer.lifecyclePlanId && !plans.has(peer.lifecyclePlanId)) {
          const plan = await ctx.db.get(peer.lifecyclePlanId);
          invariant(
            plan?.projectId === projectId,
            'SOURCE_UNAVAILABLE',
            'The retained lifecycle marker is unavailable.',
          );
          plans.set(peer.lifecyclePlanId, plan);
        }
      const currentPeers = peers.filter(
        peer =>
          versions.get(peer.laneId) === peer.recordVersion &&
          (!peer.lifecyclePlanId || plans.get(peer.lifecyclePlanId)?.status !== 'applied'),
      );
      const complete =
        peers.length <= 50 &&
        headers.length <= 50 &&
        headers.every(header =>
          peers.some(peer => peer.laneId === header.key && peer.recordVersion === header.version),
        );
      const answered = new Set(acks.map(ack => ack.noticeId));
      const compute = () =>
        hostedOverlapAdvice(
          focus,
          currentPeers.slice(0, 50),
          latest,
          main,
          answered,
          complete,
          Math.min(50, Math.max(1, Math.floor(items ?? (detail ? 50 : 5)))),
          path,
        );
      let advice = compute();
      // Presence is for members with write access only; readers and public viewers get no field.
      const writer =
        presence &&
        (await activeProject(ctx, projectId, user.subject).then(
          () => true,
          () => false,
        ));
      const present = writer
        ? {
            presence: await readHostedPresence(
              ctx,
              projectId,
              {
                laneId,
                intentId: lane.intentId,
                goal: mine?.intent ?? '',
                paths: (JSON.parse(focus.changes) as { path: string }[]).map(change => change.path),
                actor: user.subject,
              },
              presence.since,
            ),
          }
        : {};
      // Preflight selection input: free here, the Lane's projection is already loaded.
      const evidence =
        detail || path
          ? {
              peerEvidence: {
                ...hostedOverlapAdvice(
                  focus,
                  currentPeers.slice(0, 50),
                  latest,
                  main,
                  new Set(),
                  complete,
                  Math.min(50, Math.max(1, Math.floor(items ?? (detail ? 50 : 5)))),
                  path,
                ).unacknowledgedOverlaps,
                scope: 'saved-paths',
                unsavedEdits: 'unavailable',
                ...(path ? { path } : {}),
              },
            }
          : {};
      const changedPaths = paths
        ? {
            changedPaths: {
              paths: (JSON.parse(focus.changes) as { path: string }[]).map(change => change.path),
              complete: focus.complete,
            },
          }
        : {};
      const board = boardCursor
        ? await boardDelivery(ctx, {
            projectId,
            viewer: user.subject,
            laneId,
            intentId: lane.intentId,
            after: boardCursor.after,
            // The first-write hook names its path: claims on it ride on the same read.
            ...(path ? { path } : {}),
            ...(path && boardCursor.claim
              ? {
                  autoClaim: {
                    open: lane.state === 'active',
                    saved: new Set(savedPaths(focus.changes)),
                    // Peers already in memory: their open state and saved paths cost no read.
                    peers: (peerLane: string) => {
                      const peer = currentPeers.find(row => row.laneId === peerLane);
                      return peer ? { open: peer.open, saved: new Set(savedPaths(peer.changes)) } : undefined;
                    },
                  },
                }
              : {}),
          })
        : undefined;
      const boardField = board ? { board } : {};
      if (acks.length > 100) {
        // A large old inbox stays bounded. Verify every displayed item against the
        // exact answer index, so an answer outside the window can never repeat.
        let checked = 0;
        for (;;) {
          const selected = advice.unacknowledgedOverlaps.items;
          let removed = false;
          for (const item of selected) {
            if (++checked > 20) break;
            const ack = await ctx.db
              .query('projectHostedOverlapAcks')
              .withIndex('by_project_and_lane_and_notice', q =>
                q.eq('projectId', projectId).eq('laneId', laneId).eq('noticeId', item.noticeId),
              )
              .take(1);
            if (ack.length) {
              answered.add(item.noticeId);
              removed = true;
            }
          }
          if (checked > 20) {
            advice.unacknowledgedOverlaps.items = [];
            break;
          }
          if (!removed) break;
          advice = compute();
        }
        return JSON.stringify({
          ...advice,
          ...changedPaths,
          ...evidence,
          ...present,
          ...boardField,
          unacknowledgedOverlaps: {
            ...advice.unacknowledgedOverlaps,
            count: null,
            coverage: 'hosted-incomplete',
          },
        });
      }
      return JSON.stringify({ ...advice, ...changedPaths, ...evidence, ...present, ...boardField });
    } catch (error) {
      return report(error);
    }
  },
});
