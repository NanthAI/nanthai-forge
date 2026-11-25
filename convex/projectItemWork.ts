// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One finite page of an Item's Lanes, and optional web details. The CLI keeps its compact Lane-only reply.
import { z } from 'zod';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { readProjectRole } from './projectAuthority';
import {
  itemWorkLaneDetails,
  itemWorkLandingDetails,
  itemWorkRelated,
  visibleItemWork,
} from './projectItemWorkDetails';
import { readHostedRecord } from './projectHostedRecords';
import { itemIntents } from './projectItemIntentPages';
import { itemLanePage, itemLanePosition } from './projectItemLanePage';
import { latestItemIntentHead } from './projectItemIntentHeads';
import {
  cursorJson,
  itemLandingHistory,
  itemLandingFromNote,
  landingHistoryCursor,
  type ItemLanding,
} from './projectItemLandingHistory';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { isPlanningUuid } from '../src/planning-id';
import { AGENT_CLIENT, agentActor, isAgentSlug } from '../src/agent-slug';
import { LANDING_NOTES_PER_ITEM } from '../src/intent-landing-note';
import { landingNoteWindow } from './projectIntentLandingNoteArchive';

/** Lanes per page: 20 by default (Done-when "paged past 20"), at most 50. */
const WORK_PAGE = 20;
const WORK_PAGE_MAX = 50;
const CURSOR = 'forge-item-work-v1:';
const WEB_CURSOR = 'forge-item-work-v2:';
// Released CLI and MCP clients validate this envelope before sending the opaque cursor.
const KEYSET_CURSOR = `${CURSOR}{`;

const webPage = z.object({
  /** `first`: the Lane section has not started, so a later page begins at the newest Lane. */
  lane: z.union([z.literal('first'), itemLanePosition]).nullable(),
  history: landingHistoryCursor.nullable().optional(),
  related: z.string().nullable().optional(),
});
type WebPage = z.infer<typeof webPage>;

function workPage(cursor: string | null, detailed: boolean): WebPage {
  if (detailed && cursor?.startsWith(WEB_CURSOR)) {
    const page = webPage.safeParse(cursorJson(cursor.slice(WEB_CURSOR.length)));
    invariant(
      page.success,
      'BAD_ARGUMENT',
      'cursor: expected the nextCursor from this Item work read. Restart without a cursor.',
    );
    return page.data;
  }
  if (cursor?.startsWith(KEYSET_CURSOR)) {
    const key = itemLanePosition.safeParse(cursorJson(cursor.slice(CURSOR.length)));
    invariant(key.success, 'BAD_ARGUMENT', 'Cursor is invalid. Restart without a cursor.');
    return { lane: key.data };
  }
  invariant(
    cursor === null,
    'BAD_ARGUMENT',
    'cursor: expected the nextCursor from this Item work read. Restart without a cursor.',
  );
  return { lane: 'first' };
}

type LaneRecord = {
  id: string;
  intentId: string;
  actor: string;
  state: 'active' | 'completed' | 'abandoned';
  at: string;
  head: string;
  agentRun?: string;
  agentClient?: string;
  authorship?: { kind: 'agent' | 'person' };
  holder?: { agent?: string };
  resolution?: { origin?: { laneId: string } };
};
type WorkLaneState = 'open' | 'queued' | 'parked' | 'landed' | 'abandoned';

/** A live submission of the Intent: queued (or checking/ready), parked behind an older entry or a red main. */
function submissionState(request: Pick<Doc<'projectHostedLandingRequests'>, 'phase' | 'orderWait' | 'hold'>) {
  if (!['queued', 'checking', 'ready'].includes(request.phase)) return null;
  return request.orderWait || request.hold ? ('parked' as const) : ('queued' as const);
}

const modelOf = (client: unknown) =>
  typeof client === 'string' && AGENT_CLIENT.test(client) ? (client.split(':')[1] ?? null) : null;

export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    /** Lanes per page. Web details use pages of up to 10, CLI up to 50. */
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    details: v.optional(v.boolean()),
    /** Limit a detailed read to one section and pass the other cursor positions through unchanged. */
    only: v.optional(v.union(v.literal('lanes'), v.literal('landings'), v.literal('related'))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, itemId, limit, cursor, details, only }) => {
    try {
      invariant(isPlanningUuid(itemId), 'BAD_ARGUMENT', 'itemId: expected the full Item UUID.');
      // Signed out: nothing to read (the page says to sign in). Signed in: the Lanes list's own access rule.
      if (!(await ctx.auth.getUserIdentity())) return canonicalPayload({ role: false });
      const { actor, project } = await recordCaller(ctx, projectId);
      const detailed = details && Boolean(await readProjectRole(ctx, project, actor));
      const readLanes = !detailed || !only || only === 'lanes';
      const readLandings = detailed && (!only || only === 'landings');
      const readRelated = detailed && (!only || only === 'related');
      const visible =
        readLandings || readRelated
          ? await visibleItemWork(ctx, project, itemId, actor === project.owner)
          : null;
      const work = workPage(cursor ?? null, Boolean(detailed));
      const shown = detailed
        ? Math.min(Math.max(Math.trunc(limit ?? 10), 1), 10)
        : Math.min(Math.max(Math.trunc(limit ?? WORK_PAGE), 1), WORK_PAGE_MAX);
      const position = work.lane;
      const historyRequested = readLandings && Boolean(visible && work.history !== null);
      const intents = historyRequested ? await itemIntents(ctx, projectId, itemId) : [];
      const page =
        readLanes && position !== null
          ? await itemLanePage(ctx, projectId, itemId, position === 'first' ? null : position, shown)
          : null;
      const stateHead = await latestItemIntentHead(ctx, projectId, itemId);
      const state = stateHead?.status.startsWith('journal:') ? null : (stateHead?.status ?? null);
      const lanes: LaneRecord[] = [];
      for (const head of page?.heads ?? []) {
        const row = await readHostedRecord(ctx, {
          projectId,
          actor,
          kind: 'lane',
          key: head.key,
          selectedHead: head,
        });
        if (row) lanes.push(JSON.parse(row.value) as LaneRecord);
      }

      // The compact Lane rows keep their newest receipt. The independent web history
      // uses a receipt cursor, so paging it never rereads an exhausted Lane window.
      const landed = new Map<string, ItemLanding>();
      const landingIntents = new Set(
        lanes.filter(lane => lane.state !== 'abandoned').map(lane => lane.intentId),
      );
      for (const intentId of landingIntents) {
        const notes = await landingNoteWindow(ctx, projectId, intentId, LANDING_NOTES_PER_ITEM);
        const reverted = new Map(
          notes.filter(note => note.kind === 'reverted' && note.revertOf).map(note => [note.revertOf!, note]),
        );
        for (const note of notes) {
          if (note.kind !== 'landed') continue;
          const laneIds = [...note.laneIds, ...(note.viaLaneId ? [note.viaLaneId] : [])].filter(
            id => lanes.some(lane => lane.id === id) && !landed.has(id),
          );
          if (!laneIds.length) continue;
          const receipt = {
            ...(await itemLandingFromNote(ctx, projectId, note)),
            ...(reverted.has(note.receiptId) ? { revertedBy: reverted.get(note.receiptId)!.receiptId } : {}),
          };
          for (const laneId of laneIds) landed.set(laneId, receipt);
        }
      }
      // A Lane older than its Intent's newest notes: the overlap row names its receipt, and that note is
      // read by its own key. The stamp is only a pointer here; the note holds the landing.
      for (const lane of lanes) {
        if (landed.has(lane.id) || (lane.state !== 'completed' && (!detailed || lane.state === 'abandoned')))
          continue;
        const stamp = (
          await ctx.db
            .query('projectHostedOverlapLanes')
            .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
            .unique()
        )?.landed;
        const note = stamp
          ? await ctx.db
              .query('projectIntentLandingNotes')
              .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
                q
                  .eq('projectId', projectId)
                  .eq('receiptId', stamp.receiptId)
                  .eq('intentId', lane.intentId)
                  .eq('kind', 'landed'),
              )
              .unique()
          : null;
        if (stamp && note)
          landed.set(lane.id, {
            ...(await itemLandingFromNote(ctx, projectId, note)),
            ...(stamp.revertedBy ? { revertedBy: stamp.revertedBy.receiptId } : {}),
          });
      }

      // Open Lanes: the Intent's live submission (its newest Candidate's newest landing request).
      const submissions = new Map<
        string,
        { submissionId: string; phase: string; state: 'queued' | 'parked' }
      >();
      for (const intentId of new Set(lanes.filter(lane => lane.state === 'active').map(l => l.intentId))) {
        const [candidate] = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'candidate').eq('parent', intentId),
          )
          .order('desc')
          .take(1);
        const [request] = candidate
          ? await ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_and_candidate_and_sequence', q =>
                q.eq('projectId', projectId).eq('candidateId', candidate.key),
              )
              .order('desc')
              .take(1)
          : [];
        const live = request ? submissionState(request) : null;
        if (request && live)
          submissions.set(intentId, {
            submissionId: request.submissionId,
            phase: request.phase,
            state: live,
          });
      }

      const identity = { projectId, actor };
      const [laneDetails, history, related] = detailed
        ? await Promise.all([
            lanes.length ? itemWorkLaneDetails(ctx, identity, lanes) : undefined,
            !readLandings || !visible || work.history === null
              ? undefined
              : itemLandingHistory(ctx, projectId, intents, work.history ?? {}),
            !readRelated || !visible || work.related === null
              ? undefined
              : itemWorkRelated(ctx, visible, work.related ?? null),
          ])
        : [];
      const orderedLandings = history
        ? [...history.rows].sort((a, b) => b.at.localeCompare(a.at) || (b.sequence ?? 0) - (a.sequence ?? 0))
        : undefined;
      // On initial open (limit < page size, no cursor or section filter), hydrate check and file count
      // only for the visible landings; hidden rows keep their receipt line and hydrate on expand.
      const hydrateCount =
        orderedLandings && !only && (cursor ?? null) === null
          ? Math.min(orderedLandings.length, shown)
          : (orderedLandings?.length ?? 0);
      const landings = orderedLandings
        ? [
            ...(await itemWorkLandingDetails(ctx, projectId, orderedLandings.slice(0, hydrateCount))).map(
              ({ paths, ...row }) => ({ ...row, files: paths?.length ?? null }),
            ),
            ...orderedLandings
              .slice(hydrateCount)
              .map(row => ({ ...row, check: null, files: null, detailsPending: true as const })),
          ]
        : undefined;
      const rows = lanes.map(lane => {
        const run = [lane.agentRun, lane.holder?.agent].find(isAgentSlug);
        const agent = Boolean(run) || lane.authorship?.kind === 'agent';
        const landing = landed.get(lane.id);
        const submission = lane.state === 'active' ? submissions.get(lane.intentId) : undefined;
        const laneState: WorkLaneState =
          lane.state === 'abandoned'
            ? 'abandoned'
            : lane.state === 'completed'
              ? 'landed'
              : (submission?.state ?? 'open');
        return {
          laneId: lane.id,
          intentId: lane.intentId,
          state: laneState,
          head: lane.head,
          lastActivityAt: lane.at,
          ...laneDetails?.get(lane.id),
          actor: agentActor(lane.actor, run),
          kind: agent ? ('agent' as const) : ('person' as const),
          ...(run ? { run } : {}),
          model: agent ? modelOf(lane.agentClient) : null,
          ...(lane.resolution?.origin ? { resolves: lane.resolution.origin.laneId } : {}),
          ...(submission
            ? { landing: { submissionId: submission.submissionId, phase: submission.phase } }
            : {}),
          ...(laneState === 'landed' || landing ? { receipt: landing ?? null } : {}),
        };
      });
      const lane = !readLanes ? work.lane : (page?.next ?? null);
      const nextHistory = !readLandings ? work.history : history ? history.next : null;
      const nextRelated = !readRelated ? work.related : (related?.next ?? null);
      const continuation = {
        lane,
        ...(nextHistory === undefined ? {} : { history: nextHistory }),
        ...(nextRelated === undefined ? {} : { related: nextRelated }),
      };
      const hasContinuation = lane !== null || nextHistory !== null || nextRelated !== null;
      return canonicalPayload({
        role: true,
        intent: state,
        ...(historyRequested ? { intents: intents.length } : {}),
        lanes: rows,
        ...(landings
          ? {
              landings,
              moreLandings: history?.next !== null,
            }
          : {}),
        ...(related ? { related: related.links, moreRelated: related.next !== null } : {}),
        ...(page ? { total: page.total, atLeast: page.atLeast } : {}),
        nextCursor: detailed
          ? hasContinuation
            ? WEB_CURSOR + JSON.stringify(continuation)
            : null
          : lane === null
            ? null
            : CURSOR + JSON.stringify(lane),
      });
    } catch (error) {
      return report(error);
    }
  },
});
