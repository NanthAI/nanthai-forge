// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { projectQuery as query } from './cliServer';
import { accessibleProject, activeProject } from './projectAuthority';
import { readHostedPresence, dormantHostedPresence } from './projectHostedPresence';
import { dormantCutoff, liveOpenOverlapLanes } from './projectHostedDormancy';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import {
  hostedOverlapAdvice,
  IDLE_NOTICE_MS,
  sameResolution,
  sameStack,
  supersededSummary,
} from '../src/hosted-overlap';
import { presenceMayShare } from '../src/hosted-presence';
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
import { overlapMainFor } from './projectHostedOverlapMainLog';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { logIoAttribution } from './ioAttribution';
import { hasSymbolFacts, overlapLaneChanges, overlapLaneEntries } from './projectHostedOverlapChanges';

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

/** Called only when the active-head and open-peer windows can still be complete. */
async function dormantHeadsComplete(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  cutoff: number | null,
  unmatched: readonly { key: string }[],
  sawOtherOpen: boolean,
) {
  if (!unmatched.length) return true;
  if (cutoff === null) return false;
  if (unmatched.length <= 16 && !sawOtherOpen) {
    // Presence is one row per open Lane. Paused/ready Lanes are open but absent from the
    // active-head window. Without them, all dormant rows fit in the original 101-row window.
    const otherOpen = await ctx.db
      .query('projectHostedRecordHeads')
      .withIndex('by_project_and_kind_and_status', q =>
        q.eq('projectId', projectId).eq('kind', 'lane').gte('status', 'paused').lte('status', 'ready'),
      )
      .first();
    if (!otherOpen) {
      const rows = await Promise.all(
        unmatched.map(header =>
          ctx.db
            .query('projectHostedPresence')
            .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', header.key))
            .unique(),
        ),
      );
      return rows.every(row => row !== null && row.at <= cutoff);
    }
  }
  const dormant = await dormantHostedPresence(ctx, projectId, cutoff);
  return unmatched.every(header => dormant.has(header.key));
}

/** The CLI and first-write hook make one-shot HTTP reads. No source objects, Work hydration or scheduler. */
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
    board: v.optional(
      v.object({
        after: v.number(),
        laneAfter: v.optional(v.number()),
        projectAfter: v.optional(v.number()),
        claim: v.optional(v.literal(true)),
      }),
    ),
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
      const [mine, main] = await Promise.all([
        ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .unique(),
        channel,
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
      const current = mine && mine.head === lane.head && mine.baseHead === lane.base.head ? mine : null;
      // The row says without a read whether it saved nothing (the idle skip below).
      const savedNothing = current?.pathSummary.pathCount === 0;
      const pathSet = path ? new Set([path]) : undefined;
      // On main a path-only read uses only that path, including its own automatic claim decision.
      const focusPath = !paths && !detail && !presence && lane.base.head === main.head ? pathSet : undefined;
      const focus = current
        ? {
            ...current,
            changes: savedNothing
              ? '[]'
              : focusPath
                ? await overlapLaneEntries(ctx, current, focusPath)
                : await overlapLaneChanges(ctx, current),
            baseSequence,
            ...links,
          }
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
      const explicitEvidence = Boolean(detail || path);
      const stacked = Boolean(lane.stack && !lane.stack.detached);
      const canOffer = !detail && lane.state === 'active' && !stacked;
      // Ordinary receipts use path comparisons only to select a stack offer. A peer can
      // back an offer only after its canonical landing request enters ready (D2).
      // Check only the indexed row. An unrelated landing's cold bodies are irrelevant.
      const hasReadyLanding = () =>
        landingRequestOriginalDb(ctx.db)
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', projectId).eq('channel', 'main').eq('phase', 'ready'),
          )
          .first()
          .then(row => row !== null);
      const [latest, needsPeers] = await Promise.all([
        // Only behind-main Lanes need history. Read the bounded landing log after their base
        // (Issue 750c5929), falling back to the compact row when the log cannot cover it.
        lane.base.head === main.head
          ? null
          : overlapMainFor(ctx, projectId, baseSequence, new Set(savedPaths(focus.changes))),
        !idle && (explicitEvidence || (canOffer && hasReadyLanding())),
      ]);
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
      const [peers, headers] = needsPeers
        ? await readPeers()
        : ([[], []] as Awaited<ReturnType<typeof readPeers>>);
      const versions = new Map(headers.map(header => [header.key, header.version]));
      let sawOtherOpen = false;
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
          else if (head?.status === 'paused' || head?.status === 'ready') sawOtherOpen = true;
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
      // Dormant Lanes stay active heads but are left out of the peers on purpose.
      const complete =
        peers.length <= 50 &&
        headers.length <= 50 &&
        (await dormantHeadsComplete(ctx, projectId, cutoff, unmatched, sawOtherOpen));
      // Keep every current peer in the window for ordering and completeness. Only its bucket
      // reads can be pruned. Exact path summaries can reject a peer; Bloom hits still need the bucket.
      const mineSaved = new Set(savedPaths(focus.changes));
      const mineFacts = !path && !detail && !scope?.length && hasSymbolFacts(focus.changes);
      const peerChanges = async (peer: (typeof currentPeers)[number]) => {
        if (!peer.open || peer.laneId === laneId || peer.pathSummary.pathCount === 0) return '[]';
        // Advice skips related Lanes, but the board still needs to hide a claim after a related
        // Lane saves that path.
        if (!(pathSet && boardCursor?.claim) && (sameResolution(focus, peer) || sameStack(focus, peer)))
          return '[]';
        if (pathSet)
          return presenceMayShare(peer.pathSummary, pathSet) ? overlapLaneEntries(ctx, peer, pathSet) : '[]';
        if (detail || scope?.length || (mineFacts && peer.symbolFacts)) return overlapLaneChanges(ctx, peer);
        return presenceMayShare(peer.pathSummary, mineSaved)
          ? overlapLaneEntries(ctx, peer, mineSaved)
          : '[]';
      };
      const peerViews = await Promise.all(
        currentPeers.map(async peer => ({ ...peer, changes: await peerChanges(peer) })),
      );
      const advice = hostedOverlapAdvice(
        focus,
        peerViews.slice(0, 50),
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
        if (!canOffer) return {};
        const pairs = advice.overlaps.items.filter(
          item => item.reason !== 'hot-file' && item.reason !== 'idle-lanes',
        );
        const named = pairs.flatMap(item => item.lanes.filter(id => id !== laneId));
        if (!named.length) return {};
        const landings = await peerLandings(ctx, projectId, named);
        const offer = stackOffer({
          laneId,
          stacked: false,
          landing: false,
          mode: stackingMode(effectivePolicy(project as Parameters<typeof effectivePolicy>[0]).agentDefaults),
          peers: [...landings].map(([id, landing]) => ({ laneId: id, landing })),
        });
        return offer ? { stackOffer: offer } : {};
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
      const evidence = explicitEvidence
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
            ...(boardCursor.laneAfter !== undefined ? { laneAfter: boardCursor.laneAfter } : {}),
            ...(boardCursor.projectAfter !== undefined ? { projectAfter: boardCursor.projectAfter } : {}),
            // The first-write hook names its path (without detail/presence): claims on it ride on the same read,
            // while unread inbox notes stay for command replies and wait (Item f3495abe).
            ...(path ? { path, skipInbox: !detail && !presence } : {}),
            ...(path && boardCursor.claim
              ? {
                  autoClaim: {
                    open: lane.state === 'active',
                    saved: mineSaved,
                    // Peers already in memory: their open state and saved paths cost no read.
                    peers: (peerLane: string) => {
                      const peer = peerViews.find(row => row.laneId === peerLane);
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
      // From the row already read: one read tells a superseded Lane from a live one (Item 3f70760d).
      const superseded =
        lane.state === 'active' && mine?.superseded?.laneHead === lane.head ? mine.superseded : undefined;
      const supersededField = superseded
        ? {
            superseded: {
              by: superseded.by,
              receiptId: superseded.receiptId,
              at: superseded.at,
              summary: supersededSummary(superseded.by, superseded.receiptId),
            },
          }
        : {};
      const offered = await coordinate();
      // Bytes by read mode in the spend ledger (Item 411727ba): path (the hook), default, detail, scope.
      await logIoAttribution(
        ctx,
        `overlaps/${path ? 'path' : detail ? 'detail' : scope?.length ? 'scope' : 'default'}`,
      );
      return JSON.stringify({
        behindMain: advice.behindMain,
        // Installed CLIs before flip 4 part 2 require this field; empty, so they show no path notice.
        ...(explicitEvidence ? {} : { unacknowledgedOverlaps: RETIRED_OVERLAPS }),
        ...offered,
        ...changedPaths,
        ...evidence,
        ...present,
        ...boardField,
        ...stackField,
        ...conflictsField,
        ...supersededField,
      });
    } catch (error) {
      return report(error);
    }
  },
});
