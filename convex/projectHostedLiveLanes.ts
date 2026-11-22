// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import {
  readHostedIntentLabel,
  readHostedRecord,
  hostedRecordBody,
  recordHead,
} from './projectHostedRecords';
import { isAgentSlug } from '../src/agent-slug';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { abandonClass, dormantCutoff, landedByReceipt, overlapEvidence } from './projectHostedDormancy';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { isPlanningUuid } from '../src/planning-id';
import { presenceMayShare } from '../src/hosted-presence';
import { saveFailureForViewer } from './projectHostedSaveStore';
import type { TreeOverlap } from '../src/lanes-tree';

/** One bounded indexed page, selected metadata only; no source objects or idle work. */

/** Overlap peers listed per Lane in `lanes {"view":"tree"}` (57c6f3ec), and shared paths named per peer. */
const TREE_OVERLAPS = 5;
const TREE_PATHS = 3;
type TreeRow = {
  laneId: string;
  stackOn: string | null;
  presence: { paths: string[]; pathCount: number; pathBloom?: string } | null;
};

/** Pairs the page's Lanes that share saved paths: exact on the listed paths, `maybe` when only a path
 * filter matches. A Lane and the Lane it stacks on are one stack and never overlap. Uses only rows the
 * query already read: no extra document. */
function pageOverlaps(lanes: TreeRow[]) {
  const overlaps = new Map<string, TreeOverlap[]>();
  for (const lane of lanes) {
    if (!lane.presence) continue;
    const mine = new Set(lane.presence.paths);
    const found: TreeOverlap[] = [];
    for (const peer of lanes) {
      if (found.length >= TREE_OVERLAPS) break;
      if (peer === lane || !peer.presence || peer.stackOn === lane.laneId || lane.stackOn === peer.laneId)
        continue;
      const shared = peer.presence.paths.filter(path => mine.has(path)).slice(0, TREE_PATHS);
      if (shared.length) found.push({ laneId: peer.laneId, paths: shared });
      else if (
        presenceMayShare(peer.presence, mine) ||
        presenceMayShare(lane.presence, new Set(peer.presence.paths))
      )
        found.push({ laneId: peer.laneId, paths: [], maybe: true });
    }
    if (found.length) overlaps.set(lane.laneId, found);
  }
  return overlaps;
}

export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
    byline: v.optional(v.literal(true)),
    planningItemId: v.optional(v.string()),
    intentId: v.optional(v.string()),
    /** `live` leaves out dormant Lanes, `dormant` lists only them with whether each is abandonable;
     * `all` (default) lists every open Lane and marks the dormant ones; `tree` is `all` plus each
     * Lane's stack parent, landing hold and overlaps with the page's other Lanes (Issue 57c6f3ec):
     * one slim presence point read per Lane, no other read. */
    view: v.optional(v.union(v.literal('all'), v.literal('live'), v.literal('dormant'), v.literal('tree'))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, limit, view, planningItemId, intentId, byline }) => {
    try {
      invariant(
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
        'BAD_ARGUMENT',
        'limit: expected an integer from 1 to 100. Run lanes {"limit":50}.',
      );
      invariant(
        cursor === null || cursor.startsWith('forge-lanes-v1:'),
        'BAD_ARGUMENT',
        'cursor: expected the continueCursor from lanes. Run lanes {} to restart the page.',
      );
      const { actor, project } = await recordCaller(ctx, projectId);
      invariant(
        (!planningItemId || isPlanningUuid(planningItemId)) && (!intentId || isPlanningUuid(intentId)),
        'BAD_ARGUMENT',
        'Use planningItemId with a full Issue UUID, or intentId with a full execution Intent UUID.',
      );
      let parent = intentId;
      if (planningItemId) {
        // Match planned start and planning reconciliation, including reopened Issues. Head-only
        // point reads, bounded by the existing chain bound; no Lane scans or client follow-ups.
        let current = planningItemId;
        let head = await recordHead(ctx, projectId, 'intent', current);
        for (
          let hop = 0;
          head && intentFinished(head.status.replace(/^journal:/, '')) && hop < maxIntentChain;
          hop++
        ) {
          const nextId = successorIntentId(current);
          const next = await recordHead(ctx, projectId, 'intent', nextId);
          if (!next) break;
          current = nextId;
          head = next;
        }
        invariant(
          !intentId || intentId === current,
          'BAD_ARGUMENT',
          'planningItemId and intentId select different work. Use planningItemId for the Issue, or intentId for one execution Intent.',
        );
        parent = current;
      }
      const binding = canonicalPayload({
        planningItemId: planningItemId ?? null,
        intentId: parent ?? null,
        view: view ?? 'all',
      });
      let providerCursor = cursor === null ? null : cursor.slice('forge-lanes-v1:'.length);
      if (providerCursor?.startsWith('filter:')) {
        let retained;
        try {
          retained = JSON.parse(providerCursor.slice('filter:'.length));
        } catch {
          /* Invalid below. */
        }
        invariant(
          retained?.binding === binding && typeof retained.cursor === 'string',
          'BAD_ARGUMENT',
          'Lane filters changed or cursor is invalid. Restart lanes with planningItemId or intentId and no cursor.',
        );
        providerCursor = retained.cursor;
      } else
        invariant(
          !providerCursor || !parent,
          'BAD_ARGUMENT',
          'Use the continueCursor returned for this planningItemId or intentId filter.',
        );
      const cutoff = dormantCutoff(project);
      const heads = ctx.db.query('projectHostedRecordHeads');
      const matching = parent
        ? heads.withIndex('by_project_and_kind_and_parent_and_status', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', parent).eq('status', 'active'),
          )
        : heads.withIndex('by_project_and_kind_and_status', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
          );
      const page = await matching
        .order('desc')
        .paginate({ cursor: providerCursor, numItems: limit, maximumRowsRead: limit });
      const lanes = [];
      const tree = view === 'tree',
        treeRows: TreeRow[] = [];
      for (const head of page.page) {
        // Includes staged lifecycle overlays, so completed cascades never appear live.
        const row = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: head.key });
        if (!row) continue;
        const lane = hostedLaneSchema.parse(JSON.parse(row.value));
        if (lane.state !== 'active') continue;
        // Dormant: no record write (save, start, sync, landing) within the project's dormantAfterDays.
        const dormant = cutoff !== null && Date.parse(lane.at) <= cutoff;
        if ((view === 'live' && dormant) || (view === 'dormant' && !dormant)) continue;
        const overlap =
          dormant && view === 'dormant'
            ? await ctx.db
                .query('projectHostedOverlapLanes')
                .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
                .unique()
            : undefined;
        // Saved work with no landing stamp: ask the receipts (a lost completion tick leaves no stamp).
        const stamped = abandonClass(lane, overlap ?? null);
        const receipt =
          overlap !== undefined && !stamped ? await landedByReceipt(ctx, projectId, lane) : null;
        const evidence =
          overlap !== undefined && !stamped && !receipt ? overlapEvidence(lane, overlap) : null;
        const stale = dormant
          ? {
              dormant: true,
              ...(view === 'dormant'
                ? {
                    abandonable: receipt ? ('landed' as const) : stamped,
                    // Paths this Lane changed and the bytes it ends with: the CLI proves them against main.
                    ...(evidence ? { changes: evidence } : {}),
                    pinned: lane.pinned === true,
                    // False: the Lane's overlap row predates the activity index; abandon-dormant stamps it.
                    indexed: overlap ? overlap.lastActivityAt !== undefined : null,
                  }
                : {}),
            }
          : {};
        const intent = await readHostedIntentLabel(ctx, { projectId, actor, intentId: lane.intentId });
        const [saved] = await ctx.db
          .query('projectHostedRecords')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'save').eq('parent', lane.id),
          )
          .order('desc')
          .take(1);
        const [candidate] = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'candidate').eq('parent', lane.intentId),
          )
          .order('desc')
          .take(1);
        const [landing] = candidate
          ? await ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_and_candidate_and_sequence', q =>
                q.eq('projectId', projectId).eq('candidateId', candidate.key),
              )
              .order('desc')
              .take(1)
          : [];
        const save = saved
          ? (JSON.parse(await hostedRecordBody(ctx, saved)) as {
              at: string;
              actor?: string;
              authorship?: { kind: 'agent' | 'person' };
              agentRun?: string;
              agentClient?: string;
            })
          : null;
        // A save carries its own author and its own declaration, including when it made no declaration.
        const stamp = save ?? lane;
        lanes.push({
          laneId: lane.id,
          intentId: lane.intentId,
          intent: intent.title,
          // Keep the list contract for CLI callers. The Yard asks for the saver, and for
          // Mine it keeps the ownership comparison so the reply only names one account per Lane.
          actor: byline ? (save?.actor ?? lane.actor) : lane.actor,
          ...(byline
            ? {
                ...(save?.actor && save.actor !== lane.actor ? { mine: lane.actor === actor } : {}),
                ...(isAgentSlug(stamp.agentRun) ? { agentRun: stamp.agentRun } : {}),
                ...(stamp.agentClient ? { agentClient: stamp.agentClient } : {}),
                ...(stamp.authorship?.kind === 'agent' ? { agent: true } : {}),
              }
            : {}),
          state: lane.state,
          head: lane.head,
          ...(head.saveFailure
            ? { saveFailure: await saveFailureForViewer(ctx, head.saveFailure, project, actor) }
            : {}),
          // A resolution Lane names the conflicted Lane it continues (Item d9e1ac62): from the record already read.
          ...(lane.resolution?.origin ? { resolves: lane.resolution.origin.laneId } : {}),
          // Parked (Item e1633718): who it waits on, why and since when, from the record already read.
          ...(lane.park ? { park: { ...lane.park, named: Boolean(lane.park.to) } } : {}),
          lastSaveAt: save?.at ?? null,
          // Last Lane-record change (save, start, sync, landing), from the record already read (f0d0fdd6).
          lastActivityAt: lane.at,
          landing: landing
            ? { submissionId: landing.submissionId, state: landing.phase, scope: 'intent' }
            : null,
          ...stale,
          ...(tree
            ? {
                stackOn: lane.stack && !lane.stack.detached ? lane.stack.laneId : null,
                ...(landing?.hold || landing?.orderWait ? { held: landing.hold ?? 'order' } : {}),
              }
            : {}),
        });
        if (tree) {
          const presence = await ctx.db
            .query('projectHostedPresence')
            .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
            .first();
          treeRows.push({
            laneId: lane.id,
            stackOn: lane.stack && !lane.stack.detached ? lane.stack.laneId : null,
            presence,
          });
        }
      }
      if (tree) {
        const overlaps = pageOverlaps(treeRows);
        for (const row of lanes) {
          const found = overlaps.get(row.laneId);
          if (found) Object.assign(row, { overlaps: found });
        }
      }
      return canonicalPayload({
        page: lanes,
        isDone: page.isDone,
        continueCursor: page.isDone
          ? null
          : `forge-lanes-v1:${parent ? `filter:${canonicalPayload({ binding, cursor: page.continueCursor })}` : page.continueCursor}`,
      });
    } catch (error) {
      if (error instanceof Error && /(?:InvalidCursor|invalid cursor|pagination cursor)/i.test(error.message))
        return report(
          new ForgeError(
            'BAD_ARGUMENT',
            'cursor: expected the continueCursor from lanes. Run nforge agent ROOT lanes {} to restart the page.',
          ),
        );
      return report(error);
    }
  },
});
