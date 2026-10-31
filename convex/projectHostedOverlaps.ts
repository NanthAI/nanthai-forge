// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedOverlapAdvice } from '../src/hosted-overlap';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One finite agent read. No source objects, Work hydration, scheduler or subscription. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string(), paths: v.optional(v.literal(true)) },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId, paths }) => {
    try {
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
      const [mine, peers, main, latest, acks, headers] = await Promise.all([
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .unique(),
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
          .order('desc')
          .take(51),
        hostedStartMain(ctx, projectId),
        ctx.db
          .query('projectHostedOverlapMain')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .unique(),
        ctx.db
          .query('projectHostedOverlapAcks')
          .withIndex('by_project_and_lane_and_notice', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .take(101),
        ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_status', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
          )
          .order('desc')
          .take(51),
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
          ? { ...mine, baseSequence }
          : {
              laneId,
              intentId: lane.intentId,
              actor: lane.actor,
              intent: lane.intentId,
              head: lane.head,
              baseHead: lane.base.head,
              baseSequence,
              open: lane.state === 'active',
              changes: '[]',
              complete: lane.head === lane.base.head,
            };
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
        hostedOverlapAdvice(focus, currentPeers.slice(0, 50), latest, main, answered, complete);
      let advice = compute();
      // Preflight selection input: free here, the Lane's projection is already loaded.
      const changedPaths = paths
        ? {
            changedPaths: {
              paths: (JSON.parse(focus.changes) as { path: string }[]).map(change => change.path),
              complete: focus.complete,
            },
          }
        : {};
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
          unacknowledgedOverlaps: {
            ...advice.unacknowledgedOverlaps,
            count: null,
            coverage: 'hosted-incomplete',
          },
        });
      }
      return JSON.stringify({ ...advice, ...changedPaths });
    } catch (error) {
      return report(error);
    }
  },
});
