// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { recordCaller } from './projectHostedFrictionStore';
import {
  readHostedIntentLabel,
  readHostedRecord,
  hostedRecordBody,
  recordHead,
} from './projectHostedRecords';
import { intentBelongsToItem, legacyItemIntentHead } from './projectItemIntentHeads';
import { itemIntentPage, type ItemIntentPosition } from './projectItemIntentPages';
import { verifiedItemMembership } from './projectItemMembershipVersion';
import { z } from 'zod';
import { isAgentSlug } from '../src/agent-slug';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { landingStateOf, type LandingStateName } from '../src/landing-state';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { abandonClass, dormantCutoff, landedByReceipt, overlapEvidence } from './projectHostedDormancy';
import { isPlanningUuid } from '../src/planning-id';
import { presenceMayShare } from '../src/hosted-presence';
import { saveFailureForViewer } from './projectHostedSaveStore';
import type { TreeOverlap } from '../src/lanes-tree';
import { supersededSummary } from '../src/hosted-overlap';
import { laneConflicts } from './projectHostedConflicts';
import { NOTICE_PATHS } from '../src/conflict-notice-paths';

const openPosition = z.object({
  next: z.union([z.literal('indexed'), z.tuple([z.number(), z.string()])]).nullable(),
  child: z.object({ intentId: z.string(), cursor: z.string() }).optional(),
});

function activeHeads(ctx: QueryCtx, projectId: Id<'hostedProjects'>, parent?: string) {
  const heads = ctx.db.query('projectHostedRecordHeads');
  return parent
    ? heads.withIndex('by_project_and_kind_and_parent_and_status', q =>
        q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', parent).eq('status', 'active'),
      )
    : heads.withIndex('by_project_and_kind_and_status', q =>
        q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
      );
}

/** Page the newest Intent's active index first, then earlier Intent membership. Closed Lanes
 * never consume the page budget. A continuation pins the exact parent while paging its Lanes. */
async function indexedOpenPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  cursor: string | null,
  limit: number,
) {
  let position: z.infer<typeof openPosition> = { next: null };
  if (cursor !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(cursor);
    } catch {
      /* Invalid below. */
    }
    const parsed = openPosition.safeParse(raw);
    invariant(parsed.success, 'BAD_ARGUMENT', 'Use the continueCursor from this Item’s open Lanes.');
    position = parsed.data;
  }
  let next: ItemIntentPosition | null = position.next;
  let head;
  if (position.child) {
    head = await recordHead(ctx, projectId, 'intent', position.child.intentId);
    invariant(
      head && intentBelongsToItem(head, itemId),
      'BAD_ARGUMENT',
      'The cursor’s Intent no longer belongs to this Item.',
    );
  } else {
    const group = await itemIntentPage(ctx, projectId, itemId, next, 1, 'desc');
    head = group.heads[0];
    next = group.next;
  }
  if (!head) return { page: [], isDone: true, continueCursor: null };
  const page = await activeHeads(ctx, projectId, head.key)
    .order('desc')
    .paginate({
      cursor: position.child?.cursor ?? null,
      numItems: limit,
      maximumRowsRead: limit,
    });
  const isDone = page.isDone && next === null;
  return {
    page: page.page,
    isDone,
    continueCursor: isDone
      ? null
      : JSON.stringify({
          next,
          ...(!page.isDone ? { child: { intentId: head.key, cursor: page.continueCursor } } : {}),
        }),
  };
}

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

const ENDED_CAUSES: readonly LandingStateName[] = [
  'conflict',
  'check-failed',
  'not-run',
  'cancelled',
  'stale-head',
  'rejected',
];
/** The observed cause of an ended landing (src/landing-state.ts), from its stored record; nothing when it cannot be read. */
function endedCause(value: string) {
  let record: unknown;
  try {
    record = JSON.parse(value);
  } catch {
    return {};
  }
  const parsed = storedLandingStateSchema.safeParse(record);
  if (!parsed.success) return {};
  const cause = landingStateOf(parsed.data).state;
  return ENDED_CAUSES.includes(cause) ? { cause } : {};
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
      const verified = project.itemLaneMembership === verifiedItemMembership;
      const indexedItem = !intentId && verified ? planningItemId : undefined;
      let parent = intentId;
      if (planningItemId && !indexedItem) {
        if (intentId && verified) {
          const head = await recordHead(ctx, projectId, 'intent', intentId);
          invariant(
            head && intentBelongsToItem(head, planningItemId),
            'BAD_ARGUMENT',
            'planningItemId and intentId select different work.',
          );
        } else {
          const current = (await legacyItemIntentHead(ctx, projectId, planningItemId))?.key ?? planningItemId;
          invariant(
            !intentId || intentId === current,
            'BAD_ARGUMENT',
            'planningItemId and intentId select different work.',
          );
          parent = current;
        }
      }
      const legacyBinding = {
        planningItemId: planningItemId ?? null,
        intentId: parent ?? null,
        view: view ?? 'all',
      };
      // Keep the released CLI envelope. Version the bound stream, not the opaque outer prefix.
      const binding = canonicalPayload(
        indexedItem ? { ...legacyBinding, projectId, stream: 'item-v2' } : legacyBinding,
      );
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
          indexedItem
            ? 'The Item’s open-Lane stream changed. Restart lanes with planningItemId and no cursor.'
            : 'Lane filters changed or cursor is invalid. Restart lanes with planningItemId or intentId and no cursor.',
        );
        providerCursor = retained.cursor;
      } else
        invariant(
          !providerCursor || (!parent && !indexedItem),
          'BAD_ARGUMENT',
          'Use the continueCursor returned for this planningItemId or intentId filter.',
        );
      const cutoff = dormantCutoff(project);
      const page = indexedItem
        ? await indexedOpenPage(ctx, projectId, indexedItem, providerCursor, limit)
        : await activeHeads(ctx, projectId, parent)
            .order('desc')
            .paginate({ cursor: providerCursor, numItems: limit, maximumRowsRead: limit });
      const lanes = [];
      const tree = view === 'tree',
        treeRows: TreeRow[] = [];
      for (const head of page.page) {
        // Includes staged lifecycle overlays, so completed cascades never appear live.
        const row = await readHostedRecord(ctx, {
          projectId,
          actor,
          kind: 'lane',
          key: head.key,
          selectedHead: head,
        });
        if (!row) continue;
        const lane = hostedLaneSchema.parse(JSON.parse(row.value));
        if (lane.state !== 'active') continue;
        // Dormant: no record write (save, start, sync, landing) within the project's dormantAfterDays.
        const dormant = cutoff !== null && Date.parse(lane.at) <= cutoff;
        if ((view === 'live' && dormant) || (view === 'dormant' && !dormant)) continue;
        // One indexed point read per listed Lane, which also carries the supersede stamp (Item 3f70760d).
        const overlapRow = await ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
          .unique();
        const overlap = dormant && view === 'dormant' ? overlapRow : undefined;
        // Same rule as `status`: a stamp for an older head means a later save made the Lane live again.
        const superseded = overlapRow?.superseded?.laneHead === lane.head ? overlapRow.superseded : undefined;
        // Saved work with no landing stamp: ask the receipts (a lost completion tick leaves no stamp).
        const stamped = abandonClass(lane, overlap ?? null);
        const receipt =
          overlap !== undefined && !stamped ? await landedByReceipt(ctx, projectId, lane) : null;
        const evidence =
          overlap !== undefined && !stamped && !receipt ? await overlapEvidence(ctx, lane, overlap) : null;
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
        // The Lane's open trial-merge notices, said briefly (Item 9b9057a9): with whom and in how many files, for the
        // Lane row and the line's Conflict. Only a flagged Lane reads them; a stale one (a peer or this Lane saved
        // again, the peer landed) is dropped by `laneConflicts`, so a stale flag names nothing and shows nothing.
        const noticed =
          overlapRow?.conflicted && !dormant
            ? (await laneConflicts(ctx, projectId, lane.id, lane.head)).slice(0, 3)
            : [];
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
            ? {
                submissionId: landing.submissionId,
                state: landing.phase,
                scope: 'intent',
                // What Forge observed when the landing ended (Item 9b9057a9): the same one reading every screen and
                // agent reply uses, from the row already read. Only an ended landing has one.
                ...(landing.phase === 'terminal-failed' ? endedCause(landing.value) : {}),
              }
            : null,
          ...(superseded
            ? {
                superseded: {
                  by: superseded.by,
                  receiptId: superseded.receiptId,
                  at: superseded.at,
                  summary: supersededSummary(superseded.by, superseded.receiptId),
                },
              }
            : {}),
          ...stale,
          ...(noticed.length
            ? {
                conflicts: noticed.map(notice => ({
                  with: notice.with,
                  ...(notice.goal ? { goal: notice.goal } : {}),
                  files: new Set(notice.files.map(file => file.path)).size,
                  ...(notice.files[0] ? { path: notice.files[0].path } : {}),
                  ...(notice.files.length >= NOTICE_PATHS ? { atLeast: true as const } : {}),
                })),
              }
            : {}),
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
          : `forge-lanes-v1:${parent || indexedItem ? `filter:${canonicalPayload({ binding, cursor: page.continueCursor })}` : page.continueCursor}`,
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
