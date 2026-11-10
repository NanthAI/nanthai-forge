// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject, activeProject } from './projectAuthority';
import { readHostedPresence, dormantHostedPresence } from './projectHostedPresence';
import { dormantCutoff, liveOpenOverlapLanes } from './projectHostedDormancy';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedOverlapAdvice, IDLE_NOTICE_MS } from '../src/hosted-overlap';
import { invariant } from '../src/errors';
import { report } from './errors';
import { safeRelative } from '../src/safe-relative';
import { boardDelivery } from './projectBoardDelivery';
import { stackRestackHint } from './projectHostedStackNotice';
import { peerLandings } from './projectHostedOverlapPeers';
import { stackOffer, SCOPE_PATHS, SCOPE_PATH_CHARS } from '../src/hosted-overlap-coordination';
import { effectivePolicy } from '../src/autonomy-policy';
import { stackingMode } from '../src/agent-parallel-defaults';
import { laneConflicts } from './projectHostedConflicts';

/** Path notices were removed (flip 4, Issue 853fcde3); exact trial-merge conflicts replace them. */
const RETIRED_OVERLAPS = { count: 0, items: [], coverage: 'unavailable' } as const;

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
    /** Declared scope of a fresh Lane (start scope.paths, feature overlap-scope): files or `dir/`
     * prefixes; open peers that saved files inside it get one advisory item each. */
    scope: v.optional(v.array(v.string())),
    detail: v.optional(v.boolean()),
    /** Overlap items to list on a detail or path read (peers), 5 by default, at most 50. */
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
  handler: async (
    ctx,
    { projectId, laneId, paths, items, path, scope, detail, presence, board: boardCursor },
  ) => {
    try {
      invariant(path === undefined || safeRelative(path), 'BAD_ARGUMENT', 'Select a repository path.');
      invariant(
        scope === undefined ||
          (scope.length <= SCOPE_PATHS &&
            scope.every(entry => entry.length <= SCOPE_PATH_CHARS && safeRelative(entry.replace(/\/$/, '')))),
        'BAD_ARGUMENT',
        `scope: up to ${SCOPE_PATHS} repository paths (a trailing / selects a directory).`,
      );
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted overlaps.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      // Lanes idle past the project's dormantAfterDays are left out of every peer read below.
      const cutoff = dormantCutoff(project);
      const record = await readHostedRecord(ctx, {
        projectId,
        actor: user.subject,
        kind: 'lane',
        key: laneId,
      });
      invariant(record, 'NOT_FOUND', 'Hosted Lane not found on this project.');
      const lane = hostedLaneSchema.parse(JSON.parse(record.value));
      const channel = hostedStartMain(ctx, projectId);
      // The compact main path history (up to 128 KB, grows with project history) only feeds
      // `behindMain`, and hostedOverlapAdvice ignores it for a Lane based on the current main head
      // (no conflicts, coverage complete). Level Lanes therefore never read it.
      const [mine, main, latest] = await Promise.all([
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .unique(),
        channel,
        channel.then(current =>
          lane.base.head === current.head
            ? null
            : ctx.db
                .query('projectHostedOverlapMain')
                .withIndex('by_project', q => q.eq('projectId', projectId))
                .unique(),
        ),
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
      // Resolution origin and stack come from the Lane record itself, so a stale or missing row cannot
      // hide them (Issue ee9d5738); the stored root of a row at the same stack parent is kept.
      const links = {
        ...(lane.resolution ? { resolutionLeft: lane.resolution.left } : {}),
        ...(lane.resolution?.origin ? { resolutionOrigin: lane.resolution.origin.laneId } : {}),
        ...(lane.stack && !lane.stack.detached
          ? {
              stackRoot:
                mine?.stackParent === lane.stack.laneId && mine.stackRoot
                  ? mine.stackRoot
                  : lane.stack.laneId,
            }
          : {}),
      };
      const focus =
        mine && mine.head === lane.head && mine.baseHead === lane.base.head
          ? { ...mine, baseSequence, ...links }
          : {
              laneId,
              intentId: lane.intentId,
              actor: lane.actor,
              intent: lane.intentId,
              head: lane.head,
              baseHead: lane.base.head,
              ...links,
              baseSequence,
              open: lane.state === 'active',
              changes: '[]',
              complete: lane.head === lane.base.head,
            };
      // A Lane with no saved path changes cannot overlap anything: skip the peer and head
      // reads (the bulk of this query's I/O) instead of scanning every open Lane for nothing.
      const idle = !path && !scope?.length && focus.complete && focus.changes === '[]';
      const readPeers = () =>
        Promise.all([
          liveOpenOverlapLanes(ctx, projectId, cutoff),
          ctx.db
            .query('projectHostedRecordHeads')
            .withIndex('by_project_and_kind_and_status', q =>
              q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
            )
            .order('desc')
            .take(51),
        ]);
      const [peers, headers] = idle ? ([[], []] as Awaited<ReturnType<typeof readPeers>>) : await readPeers();
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
      const unmatched = headers.filter(
        header => !peers.some(peer => peer.laneId === header.key && peer.recordVersion === header.version),
      );
      // Dormant Lanes stay active heads but are left out of the peers on purpose: their slim presence
      // rows excuse them. Read only when an active head has no peer row.
      const dormantLanes =
        cutoff !== null && unmatched.length ? await dormantHostedPresence(ctx, projectId, cutoff) : null;
      const complete =
        peers.length <= 50 &&
        headers.length <= 50 &&
        unmatched.every(header => dormantLanes?.has(header.key));
      const advice = hostedOverlapAdvice(
        focus,
        currentPeers.slice(0, 50),
        latest,
        main,
        complete,
        Math.min(50, Math.max(1, Math.floor(items ?? (detail ? 50 : 5)))),
        path,
        // The default read summarizes idle Lanes in one line; detail and path reads list them all.
        detail || path ? undefined : Date.now() - IDLE_NOTICE_MS,
        scope?.length ? scope : undefined,
      );
      // The stack offer (D2): bounded reads, only for peers sharing a saved file. A detail read is a
      // listing of every peer (board, peers(detail)); it carries no phases.
      const coordinate = async () => {
        if (detail) return {};
        const pairs = advice.overlaps.items.filter(
          item => item.reason !== 'hot-file' && item.reason !== 'idle-lanes',
        );
        const named = pairs.flatMap(item => item.lanes.filter(id => id !== laneId));
        if (!named.length) return {};
        const landings = await peerLandings(ctx, projectId, named);
        const offer = stackOffer({
          laneId,
          stacked: Boolean(lane.stack && !lane.stack.detached),
          landing: false,
          mode: stackingMode(effectivePolicy(project as Parameters<typeof effectivePolicy>[0]).agentDefaults),
          peers: [...landings].map(([id, landing]) => ({ laneId: id, landing })),
        });
        return offer && lane.state === 'active' ? { stackOffer: offer } : {};
      };
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
                // This agent run's own earlier Lanes and the Lane a resolution resolves are not
                // "another agent" (d730121f): both ride rows already read, no added read.
                ...(mine?.agent ? { agent: mine.agent } : {}),
                ...(lane.resolution?.origin ? { origin: lane.resolution.origin.laneId } : {}),
              },
              presence.since,
              cutoff,
            ),
          }
        : {};
      // peers(path|detail) and preflight selection input: free here, the Lane's projection is already loaded.
      const evidence =
        detail || path
          ? {
              peerEvidence: {
                ...advice.overlaps,
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
      // A stacked Lane whose parent saved newer work (Issue f61e9339): one point read, none without a stack.
      const hint = await stackRestackHint(ctx, projectId, {
        id: laneId,
        state: lane.state,
        stack: lane.stack,
      });
      const stackField = hint ? { stack: hint } : {};
      // Exact conflicts a trial merge of saved files found (flip 4): one small index read.
      const found = lane.state === 'active' ? await laneConflicts(ctx, projectId, laneId, lane.head) : [];
      const conflictsField = found.length ? { conflicts: found } : {};
      const offered = await coordinate();
      return JSON.stringify({
        behindMain: advice.behindMain,
        // Installed CLIs before flip 4 part 2 require this field; empty, so they show no path notice.
        ...(detail || path ? {} : { unacknowledgedOverlaps: RETIRED_OVERLAPS }),
        ...offered,
        ...changedPaths,
        ...evidence,
        ...present,
        ...boardField,
        ...stackField,
        ...conflictsField,
      });
    } catch (error) {
      return report(error);
    }
  },
});
