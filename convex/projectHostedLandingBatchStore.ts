import { batchFailureSchema, batchMemberDetailSchema } from '../src/hosted-batch-diagnosis';
import { releaseBatchMembers } from './projectHostedLandingBatchRelease';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  hostedLandingAttemptSchema,
  hostedLandingStateSchema,
  landingObservation,
} from '../src/hosted-landing';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { canonicalPayload } from '../src/hosted-source-operation';
import { landingRow, loadLanding, insertLandingAttempt, writeLanding } from './projectHostedLandingStore';
import { enqueueHostedCheck } from './projectHostedChecks';
import { loadHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { invariant } from '../src/errors';

export type BatchIdentity = { projectId: Id<'hostedProjects'>; batchId: string };
export const batchSchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    composeOperationId: z.uuid(),
    checkOperationId: z.uuid(),
    phase: z.enum(['composing', 'checking', 'fallback', 'landed']),
    members: z.array(hostedLandingAttemptSchema).min(2).max(HOSTED_BATCH_MEMBERS),
    memberDetails: z.array(batchMemberDetailSchema).max(HOSTED_BATCH_MEMBERS).optional(),
    failure: batchFailureSchema.optional(),
    uploadIndex: z.number().int().nonnegative(),
    uploads: z
      .array(z.object({ pin: z.object({ sha256: z.string(), size: z.number() }), value: z.string() }))
      .max(3)
      .optional(),
    runId: z.uuid().optional(),
    included: z.array(z.uuid()).max(HOSTED_BATCH_MEMBERS).optional(),
  })
  .strict();
export type LandingBatch = z.infer<typeof batchSchema>;
export const batchRow = (ctx: QueryCtx | MutationCtx, input: BatchIdentity) =>
  ctx.db
    .query('projectHostedLandingBatches')
    .withIndex('by_project_and_batch', q => q.eq('projectId', input.projectId).eq('batchId', input.batchId))
    .unique();
export async function loadBatch(ctx: QueryCtx | MutationCtx, input: BatchIdentity) {
  const row = await batchRow(ctx, input);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The retained landing batch is unavailable.');
  return { row, batch: batchSchema.parse(JSON.parse(row.value)) };
}
export async function writeBatch(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  const { row } = await loadBatch(ctx, input);
  await ctx.db.patch(row._id, {
    value: canonicalPayload(batchSchema.parse({ ...JSON.parse(row.value), ...batch })),
  });
  if (batch.phase === 'fallback' || batch.phase === 'landed') await releaseBatchMembers(ctx, input, batch);
}
export async function wakeBatch(ctx: MutationCtx, input: BatchIdentity) {
  const { batch } = await loadBatch(ctx, input);
  if (batch.phase === 'landed') return;
  const row = await finishRow(ctx, { projectId: input.projectId, submissionId: batch.id });
  if (row) await scheduleFinish(ctx, row);
}
/** Exactly two bounded index windows, independent of project history. Eligibility
 * is pinned at admission; current authority and governance are rechecked at publish. */
export async function formLandingBatch(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    submissionId: string;
  },
  selected: Awaited<ReturnType<typeof loadLanding>>,
) {
  if (!selected.row.batchSelection || selected.state.batchId || selected.state.batchSolo) return false;
  const own = hostedLandingAttemptSchema.parse(JSON.parse(selected.row.batchSelection));
  const windows = [];
  for (const phase of ['queued', 'checking'] as const)
    windows.push(
      ...(await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_channel_and_batchable_and_phase_and_sequence', q =>
          q.eq('projectId', input.projectId).eq('channel', 'main').eq('batchable', true).eq('phase', phase),
        )
        .order('asc')
        .take(HOSTED_BATCH_MEMBERS)),
    );
  const members = windows
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap(row => {
      const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
      if (!row.batchSelection || state.batchId || state.batchSolo || state.request.finish?.after) return [];
      const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.batchSelection));
      return attempt.id === row.attemptId &&
        attempt.actor.id === own.actor.id &&
        attempt.authorityEpoch === own.authorityEpoch &&
        attempt.policyDigest === own.policyDigest &&
        canonicalPayload(state.request.check) === canonicalPayload(selected.state.request.check)
        ? [{ row, state, attempt }]
        : [];
    })
    .slice(0, HOSTED_BATCH_MEMBERS);
  if (members.length < 2 || !members.some(m => m.state.id === input.submissionId)) return false;
  const batch: LandingBatch = {
    id: members[0]!.state.id,
    at: new Date(Date.now()).toISOString(),
    composeOperationId: crypto.randomUUID(),
    checkOperationId: crypto.randomUUID(),
    phase: 'composing',
    members: members.map(m => m.attempt),
    uploadIndex: 0,
  };
  await ctx.db.insert('projectHostedLandingBatches', {
    projectId: input.projectId,
    batchId: batch.id,
    composeOperationId: batch.composeOperationId,
    value: canonicalPayload(batch),
  });
  for (const member of members)
    await writeLanding(
      ctx,
      member.row,
      {
        ...member.state,
        batchId: batch.id,
        timing: { submittedAt: member.state.at, ...member.state.timing, selectedAt: batch.at },
        version: member.state.version + 1,
        phase: 'queued',
        observation: landingObservation('queued'),
      },
      false,
    );
  await wakeBatch(ctx, { projectId: input.projectId, batchId: batch.id });
  return true;
}
/** Full gate is deliberate. B2.2 can replace this with the members' contract
 * union once its batch eligibility/acceptance policy is supplied. Provider work
 * is only scheduled, so stamping the gate stays in the reservation transaction. */
export async function enqueueBatchCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    request: unknown;
  },
) {
  const run = await enqueueHostedCheck(ctx, input);
  run.gate = { mode: 'full', reason: 'Hosted landing batch: full union gate' };
  const { row } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: run.id });
  await ctx.db.patch(row._id, { gate: run.gate });
  await writeHostedCheck(ctx, row._id, run);
  return run;
}
export async function installBatchAttempt(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    original: LandingBatch['members'][number];
    candidate?: LandingBatch['members'][number]['candidate'];
    main?: LandingBatch['members'][number]['main'];
    checkOperationId?: string;
    check: NonNullable<LandingBatch['members'][number]['check']>;
  },
) {
  const { original } = input;
  const { deferredCheck: _deferred, ...pins } = original;
  void _deferred;
  const attempt = {
    ...pins,
    ...(input.main ? { main: input.main } : {}),
    ...(input.checkOperationId ? { operations: { ...pins.operations, check: input.checkOperationId } } : {}),
    id: crypto.randomUUID(),
    parentAttemptId: original.id,
    number: original.number + 1,
    check: input.check,
    ...(input.candidate ? { candidate: input.candidate, memberCandidate: original.candidate } : {}),
  };
  await insertLandingAttempt(ctx, attempt);
  const row = await landingRow(ctx, { projectId: input.projectId, submissionId: original.submissionId });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The batch member is unavailable.');
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  await writeLanding(
    ctx,
    row,
    {
      ...state,
      version: state.version + 1,
      attemptId: attempt.id,
      phase: 'checking',
      observation: landingObservation('checking'),
      error: null,
    },
    false,
  );
  return attempt;
}
