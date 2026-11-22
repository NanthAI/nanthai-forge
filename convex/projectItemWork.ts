// SPDX-License-Identifier: Apache-2.0
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
import { itemIntentChain } from './projectIntentLandingNotes';
import {
  cursorJson,
  itemLandingHistory,
  itemLandingFromNote,
  landingHistoryCursor,
  itemLandingStamp,
  itemLaneLandingStamp,
  type ItemLanding,
} from './projectItemLandingHistory';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { isPlanningUuid } from '../src/planning-id';
import { AGENT_CLIENT, agentActor, isAgentSlug } from '../src/agent-slug';
import { LANDING_NOTES_PER_ITEM } from '../src/intent-landing-note';
import { landingNoteWindow } from './projectIntentLandingNoteArchive';

/** Lane heads counted per Intent before the total reads "at least". */
const LANES_COUNTED = 50;
/** Lanes per page: 20 by default (Done-when "paged past 20"), at most 50. */
const WORK_PAGE = 20;
const WORK_PAGE_MAX = 50;
const CURSOR = 'forge-item-work-v1:';
const WEB_CURSOR = 'forge-item-work-v2:';

const webPage = z.object({
  lane: z.number().int().min(0).nullable(),
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
  return { lane: decodeOffset(cursor) };
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

function decodeOffset(cursor: string | null) {
  if (cursor === null) return 0;
  const offset = Number(cursor.startsWith(CURSOR) ? cursor.slice(CURSOR.length) : NaN);
  invariant(
    Number.isInteger(offset) && offset > 0,
    'BAD_ARGUMENT',
    'cursor: expected the nextCursor from this Item work read. Restart without a cursor.',
  );
  return offset;
}

export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    /** Lanes per page, open first then newest. Web details use pages of up to 10, CLI up to 50. */
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    details: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, itemId, limit, cursor, details }) => {
    try {
      invariant(isPlanningUuid(itemId), 'BAD_ARGUMENT', 'itemId: expected the full Item UUID.');
      // Signed out: nothing to read (the page says to sign in). Signed in: the Lanes list's own access rule.
      if (!(await ctx.auth.getUserIdentity())) return canonicalPayload({ role: false });
      const { actor, project } = await recordCaller(ctx, projectId);
      const detailed = details && Boolean(await readProjectRole(ctx, project, actor));
      const visible = detailed ? await visibleItemWork(ctx, project, itemId, actor === project.owner) : null;
      const work = workPage(cursor ?? null, Boolean(detailed));
      const shown = detailed
        ? Math.min(Math.max(Math.trunc(limit ?? 10), 1), 10)
        : Math.min(Math.max(Math.trunc(limit ?? WORK_PAGE), 1), WORK_PAGE_MAX);
      const { intents, state } = await itemIntentChain(ctx, projectId, itemId);

      // Every Lane of the chain, any state: small head rows only, bounded per Intent.
      let total = 0;
      let atLeast = false;
      const heads: Doc<'projectHostedRecordHeads'>[] = [];
      const completeHeads = new Map<string, Doc<'projectHostedRecordHeads'>[]>();
      for (const intentId of work.lane === null ? [] : intents) {
        const rows = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
          )
          .order('desc')
          .take(LANES_COUNTED + 1);
        if (rows.length > LANES_COUNTED) atLeast = true;
        else if (visible) completeHeads.set(intentId, rows);
        total += Math.min(rows.length, LANES_COUNTED);
        heads.push(...rows.slice(0, LANES_COUNTED));
      }
      heads.sort(
        (a, b) =>
          Number(b.status === 'active') - Number(a.status === 'active') || b._creationTime - a._creationTime,
      );
      const page = work.lane === null ? [] : heads.slice(work.lane, work.lane + shown);
      const lanes: LaneRecord[] = [];
      for (const head of page) {
        const row = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: head.key });
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
      const stamps = new Map<string, Doc<'projectHostedOverlapLanes'>['landed']>();
      for (const lane of lanes) {
        if (landed.has(lane.id) || (lane.state !== 'completed' && (!detailed || lane.state === 'abandoned')))
          continue;
        const stamp = await itemLaneLandingStamp(ctx, projectId, lane.id);
        if (visible) stamps.set(lane.id, stamp);
        if (stamp) landed.set(lane.id, itemLandingStamp(stamp));
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
            itemWorkLaneDetails(ctx, identity, lanes),
            !visible || work.history === null
              ? undefined
              : itemLandingHistory(ctx, projectId, intents, work.history ?? {}, undefined, {
                  heads: completeHeads,
                  stamps,
                }),
            !visible || work.related === null
              ? undefined
              : itemWorkRelated(ctx, visible, work.related ?? null),
          ])
        : [];
      const landings = history ? await itemWorkLandingDetails(ctx, projectId, history.rows) : undefined;
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
      const next = work.lane === null ? null : work.lane + shown;
      const lane = next !== null && next < heads.length ? next : null;
      const continuation = { lane, history: history ? history.next : null, related: related?.next ?? null };
      return canonicalPayload({
        role: true,
        intent: state,
        intents: intents.length,
        lanes: rows,
        ...(landings
          ? {
              landings: landings.map(({ paths, ...row }) => ({ ...row, files: paths?.length ?? null })),
              moreLandings: history?.next !== null,
            }
          : {}),
        ...(related ? { related: related.links, moreRelated: related.next !== null } : {}),
        ...(work.lane !== null ? { total, atLeast } : {}),
        nextCursor: detailed
          ? Object.values(continuation).some(value => value !== null)
            ? WEB_CURSOR + JSON.stringify(continuation)
            : null
          : lane === null
            ? null
            : `${CURSOR}${lane}`,
      });
    } catch (error) {
      return report(error);
    }
  },
});
