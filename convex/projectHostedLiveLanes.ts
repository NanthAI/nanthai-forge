// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { readHostedRecord, hostedRecordBody, recordHead } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { abandonClass, dormantCutoff, landedByReceipt, overlapEvidence } from './projectHostedDormancy';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { isPlanningUuid } from '../src/planning-id';

/** One bounded indexed page, selected metadata only; no source objects or idle work. */
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
    planningItemId: v.optional(v.string()),
    intentId: v.optional(v.string()),
    /** `live` leaves out dormant Lanes, `dormant` lists only them with whether each is abandonable;
     * `all` (default) lists every open Lane and marks the dormant ones. */
    view: v.optional(v.union(v.literal('all'), v.literal('live'), v.literal('dormant'))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, limit, view, planningItemId, intentId }) => {
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
              lastActivityAt: lane.at,
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
        const intent = await readHostedRecord(ctx, { projectId, actor, kind: 'intent', key: lane.intentId });
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
        lanes.push({
          laneId: lane.id,
          intentId: lane.intentId,
          intent: intent ? JSON.parse(intent.value).outcome : null,
          actor: lane.actor,
          state: lane.state,
          head: lane.head,
          lastSaveAt: saved ? JSON.parse(await hostedRecordBody(ctx, saved)).at : null,
          landing: landing
            ? { submissionId: landing.submissionId, state: landing.phase, scope: 'intent' }
            : null,
          ...stale,
        });
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
