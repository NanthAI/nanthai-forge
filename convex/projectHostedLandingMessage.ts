// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { storedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { hostedOperationRow } from './projectHostedOperations';
import { hostedOperationSchema } from '../src/hosted-source-operation';
import { landingAttemptRow, landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { hostedLandingAttemptSchema } from '../src/hosted-landing';
import { landingMessage } from '../src/landing-message';
import { hostedFinishSchema } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { finishRow } from './projectHostedFinishWake';
import { readHostedRecord } from './projectHostedRecords';
import { landingMessageText } from './projectHostedLandingMessageBody';

/** Only pre-upgrade pending requests need this indexed read. New requests carry
 * the value (or explicit omission) in their existing landing record. */
export async function acceptedLandingMessage(ctx: MutationCtx, state: HostedLandingState) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  if (state.messageRef) return landingMessageText(ctx, projectId, { messageRef: state.messageRef.id });
  if (typeof state.request.message === 'string') return state.request.message;
  // A frozen value: the legacy subject, or the message a resolution inherits.
  if (state.message !== undefined) return state.message ?? undefined;
  if (state.request.message === null) return undefined;
  if (!state.request.finish || state.request.finish.reviewedSource) return undefined;
  const row = await finishRow(ctx, {
    projectId,
    submissionId: state.id,
  });
  if (!row) return undefined;
  const message = hostedFinishSchema.parse(JSON.parse(row.value)).source.message;
  return message === 'Agent change' ? undefined : landingMessage(message);
}

/** A resolution Lane carries the work of the landing that conflicted, so a finish
 * that names no message of its own keeps that landing's message and trailers
 * (GitHub f233bf1c, Issue eacfdb6e: resolution Lane c456f8db landed with none and the
 * batch commit dropped df2ba360's message). Only runs for a message-less finish of
 * exactly one Lane: one selection read, one record read, one indexed landing read,
 * all inside the existing submission transaction. A recomposed conflict follows three
 * additional indexed metadata keys (compose, operation, submission); old operations
 * also read the reserved landing attempt. Healthy landing calls and index writes
 * stay unchanged; new recomposes retain one UUID in the existing reserved-ID map. */
export async function resolutionMessage(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; composeOperationId: string },
) {
  const [selected] = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
      q
        .eq('projectId', input.projectId)
        .eq('actor', input.actor)
        .eq('operationId', input.composeOperationId)
        .eq('kind', 'inputs'),
    )
    .take(1);
  if (!selected) return undefined;
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    kind: 'lane',
    key: selected.key,
  });
  const candidateId =
    row && hostedRecordSchema.options[1].parse(JSON.parse(row.value)).resolution?.candidateId;
  if (!candidateId) return undefined;
  const [conflicted] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_candidate_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('candidateId', candidateId),
    )
    .order('desc')
    .take(1);
  if (!conflicted) {
    // A child attempt keeps the original immutable landing request. Its exact
    // Candidate indexes the compose; its reserved submission id leads to the
    // exact landing record, even when a useful claim adopted a cached precompose. Compose text cannot distinguish omission from an explicit
    // default subject, or preserve a landing override of that text.
    const compose = await ctx.db
      .query('projectHostedComposes')
      .withIndex('by_project_and_candidate', q =>
        q.eq('projectId', input.projectId).eq('candidateId', candidateId),
      )
      .unique();
    if (!compose) return undefined;
    const operation = await hostedOperationRow(ctx, input.projectId, compose.actor, compose.operationId);
    if (!operation) return undefined;
    const { firstAttempt } = hostedOperationSchema.parse(JSON.parse(operation.value));
    if (firstAttempt.ids.candidate !== candidateId) return undefined;
    let submissionId = firstAttempt.ids.submission;
    if (!submissionId) {
      // Retained ordinary recomposes predate the submission reservation. Their
      // source and landing child used the same reserved attempt id.
      const row = await landingAttemptRow(ctx, { projectId: input.projectId, attemptId: firstAttempt.id });
      if (!row) return undefined;
      const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.value));
      if (attempt.candidate.id !== candidateId) return undefined;
      submissionId = attempt.submissionId;
    }

    const origin = await landingRow(ctx, { projectId: input.projectId, submissionId });
    return origin ? acceptedLandingMessage(ctx, landingStateFromRow(origin)) : undefined;
  }
  const origin = storedLandingStateSchema.parse(JSON.parse(conflicted.value));
  if (origin.messageRef)
    return landingMessageText(ctx, input.projectId, { messageRef: origin.messageRef.id });
  return (typeof origin.request.message === 'string' ? origin.request.message : origin.message) ?? undefined;
}
