// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { laneLandingRequest } from './projectFailureCauseRead';
import { loadHostedCheck } from './projectHostedCheckStore';
import { landingMessageForReader } from './projectHostedLandingMessageBody';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';

/** Only the review of a submitted change does these bounded point/index reads. No State or check output is read. */
export async function laneReviewCandidate(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    laneId: string;
    intentId: string;
    submission?: string | undefined;
  },
) {
  const { projectId, actor, laneId, intentId, submission } = input;
  const request = submission
    ? await landingRow(ctx, { projectId, submissionId: submission })
    : (await laneLandingRequest(ctx, projectId, laneId)).request;
  if (!request || (!submission && (request.phase === 'landed' || request.phase === 'terminal-failed')))
    return null;
  const row = submission ? request : await landingRow(ctx, { projectId, submissionId: request.submissionId });
  if (!row) return null;
  const state = landingStateFromRow(row);
  if (submission) {
    const operationId = state.request.finish?.composeOperationId;
    const selected = operationId
      ? await ctx.db
          .query('projectHostedComposeSelections')
          .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
            q
              .eq('projectId', projectId)
              .eq('actor', state.actor)
              .eq('operationId', operationId)
              .eq('kind', 'inputs')
              .eq('key', laneId),
          )
          .first()
      : null;
    if (!selected) return null;
  }
  const record = await readHostedRecord(ctx, {
    projectId,
    actor,
    kind: 'candidate',
    key: state.request.candidateId,
  });
  if (!record || record.parent !== intentId) return null;
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(record.value));
  if (candidate.result.status !== 'clean' || candidate.result.head !== state.request.expectedHead)
    return null;
  const head = candidate.result.head;
  const [readable, run] = await Promise.all([
    landingMessageForReader(ctx, projectId, state),
    row.runId ? loadHostedCheck(ctx, { projectId, runId: row.runId }, false).then(read => read.run) : null,
  ]);
  return {
    candidateId: candidate.id,
    base: candidate.base.head,
    head,
    files: record.candidateFiles ?? null,
    summary: (readable.request.message ?? readable.message)?.trim() || null,
    notVerified: state.request.notVerified ?? null,
    check:
      run?.request.expectedHead === head && run.request.candidateId === candidate.id
        ? run.status
        : state.request.check
          ? null
          : ('not-run' as const),
  };
}
