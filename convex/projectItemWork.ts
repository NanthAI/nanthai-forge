// SPDX-License-Identifier: Apache-2.0
// What happened on one Item (Issue 1c2ab97a): every Lane started from it, in any state, with its saved head,
// last activity and, once landed, the receipt. One shared read for the agent CLI/MCP `planning {id}` `work`
// section, `lanes {planningItemId, state:"all"}` and the web Item page Work section (61b4b21f).
// It follows the Intent→Lane link only, never a scan of the project's Lanes. Every read is a point read or a
// bounded index range:
// - the Item's Intent chain: at most 1 + maxIntentChain head reads (the `intentStates` walk);
// - per chain Intent: one range of at most LANES_COUNTED + 1 small Lane head rows (no bodies), for `total`;
// - per shown Lane (at most `limit`): its Lane record;
// - per chain Intent with a shown open or landed Lane: one range of its newest landing notes (3a733ee8; an open
//   Lane kept open after landing carries its receipt too); a completed Lane landed before notes existed falls back
//   to its overlap row's landing stamp (one point read);
// - per chain Intent with a shown open Lane: its newest Candidate head and that Candidate's newest landing
//   request (queued or parked), the same two reads `lanes` makes.
// It writes nothing and is called once per read (never subscribed), so idle costs nothing. Who may read it is
// the Lanes list's rule (recordCaller); signed out it returns `{ role: false }`. `actor` is mapped at the
// public identity boundary (convex/publicPeople.ts): a handle for writers, nothing for anyone else.
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { readProjectRole } from './projectAuthority';
import { itemWorkLaneDetails, itemWorkLandingDetails, itemWorkRelated } from './projectItemWorkDetails';
import { readHostedRecord, recordHead } from './projectHostedRecords';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { isPlanningUuid } from '../src/planning-id';
import { AGENT_CLIENT, agentActor, isAgentSlug } from '../src/agent-slug';
import { LANDING_NOTES_PER_ITEM } from '../src/intent-landing-note';

/** Lane heads counted per Intent before the total reads "at least". */
const LANES_COUNTED = 50;
/** Lanes per page: 20 by default (Done-when "paged past 20"), at most 50. */
const WORK_PAGE = 20;
const WORK_PAGE_MAX = 50;
const CURSOR = 'forge-item-work-v1:';

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
type Landed = {
  receiptId: string;
  commit: string;
  at: string;
  sequence?: number;
  landedBy?: string;
  revertedBy?: string;
};
type WorkLaneState = 'open' | 'queued' | 'parked' | 'landed' | 'abandoned';

/** A live submission of the Intent: queued (or checking/ready), parked behind an older entry or a red main. */
function submissionState(request: Pick<Doc<'projectHostedLandingRequests'>, 'phase' | 'orderWait' | 'hold'>) {
  if (!['queued', 'checking', 'ready'].includes(request.phase)) return null;
  return request.orderWait || request.hold ? ('parked' as const) : ('queued' as const);
}

const modelOf = (client: unknown) =>
  typeof client === 'string' && AGENT_CLIENT.test(client) ? (client.split(':')[1] ?? null) : null;

/** The Item's Intents: its own (same id), then each successor started after the previous one finished. */
async function itemIntentChain(ctx: QueryCtx, projectId: Id<'hostedProjects'>, itemId: string) {
  const intents: string[] = [];
  let current = itemId;
  let head = await recordHead(ctx, projectId, 'intent', current);
  let state: string | null = null;
  for (let hop = 0; head && hop <= maxIntentChain; hop++) {
    intents.push(current);
    state = head.status.startsWith('journal:') ? null : head.status;
    if (!intentFinished(head.status.replace(/^journal:/, ''))) break;
    const next = successorIntentId(current);
    const following = await recordHead(ctx, projectId, 'intent', next);
    if (!following) break;
    current = next;
    head = following;
  }
  return { intents, state };
}

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
      const offset = decodeOffset(cursor ?? null);
      // Signed out: nothing to read (the page says to sign in). Signed in: the Lanes list's own access rule.
      if (!(await ctx.auth.getUserIdentity())) return canonicalPayload({ role: false });
      const { actor, project } = await recordCaller(ctx, projectId);
      const detailed = details && Boolean(await readProjectRole(ctx, project, actor));
      const shown = detailed
        ? Math.min(Math.max(Math.trunc(limit ?? 10), 1), 10)
        : Math.min(Math.max(Math.trunc(limit ?? WORK_PAGE), 1), WORK_PAGE_MAX);
      const { intents, state } = await itemIntentChain(ctx, projectId, itemId);

      // Every Lane of the chain, any state: small head rows only, bounded per Intent.
      let total = 0;
      let atLeast = false;
      const heads: Doc<'projectHostedRecordHeads'>[] = [];
      for (const intentId of intents) {
        const rows = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
          )
          .order('desc')
          .take(LANES_COUNTED + 1);
        if (rows.length > LANES_COUNTED) atLeast = true;
        total += Math.min(rows.length, LANES_COUNTED);
        heads.push(...rows.slice(0, LANES_COUNTED));
      }
      heads.sort(
        (a, b) =>
          Number(b.status === 'active') - Number(a.status === 'active') || b._creationTime - a._creationTime,
      );
      const page = heads.slice(offset, offset + shown);
      const lanes: LaneRecord[] = [];
      for (const head of page) {
        const row = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: head.key });
        if (row) lanes.push(JSON.parse(row.value) as LaneRecord);
      }

      // Landing receipts: the Intent's landing notes first (every landing since 3a733ee8), then the overlap stamp.
      const landed = new Map<string, Landed>();
      const recentLandings = new Map<string, Landed>();
      let landingsPartial = false;
      // The web's Landings fold pages the notes independently of the Lanes fold. The compact
      // CLI only needs the latest receipt for each shown Lane, including Lanes left open after landing.
      const landingIntents = detailed
        ? intents
        : new Set(lanes.filter(lane => lane.state !== 'abandoned').map(lane => lane.intentId));
      for (const intentId of landingIntents) {
        const notes = await ctx.db
          .query('projectIntentLandingNotes')
          .withIndex('by_project_and_intent', q => q.eq('projectId', projectId).eq('intentId', intentId))
          .order('desc')
          .take(LANDING_NOTES_PER_ITEM + (detailed ? 1 : 0));
        if (notes.length > LANDING_NOTES_PER_ITEM) {
          landingsPartial = true;
          notes.pop();
        }
        const reverted = new Map(
          notes.filter(note => note.kind === 'reverted' && note.revertOf).map(note => [note.revertOf!, note]),
        );
        for (const note of notes) {
          if (note.kind !== 'landed') continue;
          const receipt = {
            receiptId: note.receiptId,
            commit: note.commit,
            at: note.at,
            sequence: note.sequence,
            ...(note.landedBy ? { landedBy: note.landedBy.by } : {}),
            ...(reverted.has(note.receiptId) ? { revertedBy: reverted.get(note.receiptId)!.receiptId } : {}),
          };
          if (detailed) recentLandings.set(receipt.receiptId, receipt);
          for (const laneId of [...note.laneIds, ...(note.viaLaneId ? [note.viaLaneId] : [])])
            if (!landed.has(laneId)) landed.set(laneId, receipt);
        }
      }
      for (const lane of lanes) {
        if (lane.state !== 'completed' || landed.has(lane.id)) continue;
        const overlap = await ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
          .unique();
        const stamp = overlap?.landed;
        if (stamp)
          landed.set(lane.id, {
            receiptId: stamp.receiptId,
            commit: stamp.commit,
            at: stamp.at,
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

      const pageReceipts = new Map(
        [...recentLandings.values()]
          .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))
          .slice(offset, offset + shown)
          .map(receipt => [receipt.receiptId, receipt]),
      );
      if (detailed)
        for (const lane of lanes) {
          const receipt = landed.get(lane.id);
          if (receipt && !recentLandings.has(receipt.receiptId)) pageReceipts.set(receipt.receiptId, receipt);
        }
      const identity = { projectId, actor };
      const [laneDetails, landings, related] = detailed
        ? await Promise.all([
            itemWorkLaneDetails(ctx, identity, lanes),
            itemWorkLandingDetails(ctx, projectId, [...pageReceipts.values()]),
            offset === 0 ? itemWorkRelated(ctx, project, itemId, actor === project.owner) : undefined,
          ])
        : [];
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
      const next = offset + shown;
      return canonicalPayload({
        role: true,
        intent: state,
        intents: intents.length,
        lanes: rows,
        ...(landings ? { landings, landingsPartial } : {}),
        ...(related ? { related } : {}),
        total,
        atLeast,
        nextCursor: next < Math.max(heads.length, recentLandings.size) ? `${CURSOR}${next}` : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
