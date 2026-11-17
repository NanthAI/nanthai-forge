// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { readHostedRecord, hostedRecordBody } from './projectHostedRecords';
import { loadHostedCheck } from './projectHostedCheckStore';
import { auditSettings } from './projectHostedMainAuditState';
import { channelRow } from './projectHostedChannels';
import { checkEvidence } from '../src/run-evidence';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One bounded read for the page. No source bytes, report-body fetch, per-test calls or polling. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    saveId: v.optional(v.string()),
    runId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await recordCaller(ctx, input.projectId);
      const laneRow = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor,
        kind: 'lane',
        key: input.laneId,
      });
      invariant(laneRow, 'NOT_FOUND', 'This Lane is not available.');
      const lane = JSON.parse(laneRow.value);
      let saved;
      if (input.saveId) {
        const row = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor,
          kind: 'save',
          key: input.saveId,
        });
        invariant(row && row.parent === lane.id, 'NOT_FOUND', 'Select a save from this Lane.');
        saved = JSON.parse(row.value);
      } else {
        const head = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', input.projectId).eq('kind', 'save').eq('parent', lane.id),
          )
          .order('desc')
          .first();
        if (head) {
          const row = await ctx.db.get(head.recordId);
          invariant(row, 'SOURCE_UNAVAILABLE', 'The saved evidence is unavailable.');
          saved = JSON.parse(await hostedRecordBody(ctx, row));
        }
      }
      // The candidate and check are selected together; a supplied run is never silently replaced.
      const candidateHead = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', input.projectId).eq('kind', 'candidate').eq('parent', lane.intentId),
        )
        .order('desc')
        .first();
      const runRow =
        candidateHead && !input.runId
          ? await ctx.db
              .query('projectHostedCheckRuns')
              .withIndex('by_project_and_candidate', q =>
                q.eq('projectId', input.projectId).eq('candidateId', candidateHead.key),
              )
              .order('desc')
              .first()
          : null;
      const run =
        input.runId || runRow
          ? (
              await loadHostedCheck(
                ctx,
                { projectId: input.projectId, runId: input.runId ?? runRow!.runId },
                false,
              )
            ).run
          : null;
      if (run) {
        const candidate = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor,
          kind: 'candidate',
          key: run.request.candidateId,
        });
        invariant(
          candidate && candidate.parent === lane.intentId,
          'NOT_FOUND',
          'This check does not belong to this Item.',
        );
      }
      const landed = run
        ? await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_candidate_and_phase_and_sequence', q =>
              q
                .eq('projectId', input.projectId)
                .eq('candidateId', run.request.candidateId)
                .eq('phase', 'landed'),
            )
            .order('desc')
            .first()
        : null;
      const landedState = landed ? JSON.parse(landed.value) : null;
      const acceptance = landedState?.acceptance;
      const declaration =
        landedState?.request.notVerified !== undefined
          ? {
              kind: 'landing',
              id: landedState.id,
              head: acceptance?.head ?? landedState.request.expectedHead,
              at: landedState.at,
              author: landedState.actor,
              notVerified: landedState.request.notVerified,
            }
          : null;
      const main = await channelRow(ctx, input.projectId);
      const currentHead = main ? JSON.parse(main.selection).head : null;
      return canonicalPayload({
        lane: { id: lane.id, intentId: lane.intentId, head: lane.head, state: lane.state },
        save: saved
          ? {
              id: saved.id,
              head: saved.head,
              at: saved.at,
              author: saved.actor,
              ...(saved.notVerified === undefined ? {} : { notVerified: saved.notVerified }),
            }
          : null,
        declaration,
        agentClient: landed?.agentClient ?? null,
        check: checkEvidence(run),
        landing: acceptance
          ? {
              receiptId: acceptance.receiptId,
              head: acceptance.head,
              candidateId: run!.request.candidateId,
              acceptedBy: acceptance.acceptedBy ?? null,
            }
          : null,
        // A composed Candidate can differ from its Lane save: no false association with a newer save.
        claimMatchesCheck:
          run && (declaration || saved)
            ? (declaration?.head ?? saved.head) === run.request.expectedHead
            : null,
        currentHead,
        stale: run ? currentHead !== null && currentHead !== run.request.expectedHead : false,
        afterLandingCheck: await auditSettings(ctx, input.projectId),
      });
    } catch (error) {
      return report(error);
    }
  },
});
