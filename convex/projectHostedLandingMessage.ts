// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { landingMessage } from '../src/landing-message';
import { hostedFinishSchema } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { finishRow } from './projectHostedFinishWake';
import { readHostedRecord } from './projectHostedRecords';

/** Only pre-upgrade pending requests need this indexed read. New requests carry
 * the value (or explicit omission) in their existing landing record. */
export async function acceptedLandingMessage(ctx: MutationCtx, state: HostedLandingState) {
  if (typeof state.request.message === 'string') return state.request.message;
  // A frozen value: the legacy subject, or the message a resolution inherits.
  if (state.message !== undefined) return state.message ?? undefined;
  if (state.request.message === null) return undefined;
  if (!state.request.finish || state.request.finish.reviewedSource) return undefined;
  const row = await finishRow(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
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
 * all inside the existing submission transaction. */
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
  if (!conflicted) return undefined;
  const origin = hostedLandingStateSchema.parse(JSON.parse(conflicted.value));
  return (typeof origin.request.message === 'string' ? origin.request.message : origin.message) ?? undefined;
}
