import { batchFailureSchema, batchMemberDetailSchema } from '../src/hosted-batch-diagnosis';
import { releaseBatchMembers } from './projectHostedLandingBatchRelease';
// SPDX-License-Identifier: Apache-2.0
import { activeLandingOrder } from './projectHostedLandingOrder';
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
import {
  landingRow,
  landingQueue,
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
  writeLanding,
} from './projectHostedLandingStore';
import { enqueueHostedCheck } from './projectHostedChecks';
import { loadHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { retainLandingTrain } from './projectHostedLandingWake';
import { invariant } from '../src/errors';

export type BatchIdentity = { projectId: Id<'hostedProjects'>; batchId: string };
export const batchSchema = z
  .object({
    id: z.uuid(),
    leaderId: z.uuid().optional(),
    at: z.iso.datetime(),
    composeOperationId: z.uuid(),
    checkOperationId: z.uuid(),
    phase: z.enum(['composing', 'checking', 'fallback', 'landed', 'superseded']),
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
export async function writeBatch(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  replace = false,
) {
  const { row } = await loadBatch(ctx, input);
  await ctx.db.patch(row._id, {
    composeOperationId: batch.composeOperationId,
    value: canonicalPayload(batchSchema.parse(replace ? batch : { ...JSON.parse(row.value), ...batch })),
  });
  if (batch.phase === 'fallback' || batch.phase === 'landed') await releaseBatchMembers(ctx, input, batch);
  if (batch.phase === 'superseded') {
    const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    if (queue?.train?.some(id => batch.members.some(member => member.submissionId === id)))
      await ctx.db.patch(queue._id, { train: undefined });
  }
}
export async function wakeBatch(ctx: MutationCtx, input: BatchIdentity) {
  const { batch } = await loadBatch(ctx, input);
  if (batch.phase === 'landed' || batch.phase === 'superseded') return;
  const row = await finishRow(ctx, { projectId: input.projectId, submissionId: batch.leaderId ?? batch.id });
  if (row) await scheduleFinish(ctx, row);
}
/** Bounded active metadata pages, independent of retained history. Eligibility
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
  const order = await activeLandingOrder(
    ctx,
    { projectId: input.projectId, channel: 'main' },
    ['queued', 'checking'],
    true,
  );
  const windows = [];
  for (const key of order) {
    if ((key.priority ?? 'normal') !== (selected.state.priority ?? 'normal')) continue;
    const row = await landingRow(ctx, { projectId: input.projectId, submissionId: key.submissionId });
    if (row?.batchable) windows.push(row);
    if (windows.length >= HOSTED_BATCH_MEMBERS) break;
  }
  const members = windows
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
    id: crypto.randomUUID(),
    leaderId: members[0]!.state.id,
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
  await retainLandingTrain(
    ctx,
    { projectId: input.projectId, channel: 'main' },
    members.map(m => m.state.id),
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
  const row = await landingRow(ctx, { projectId: input.projectId, submissionId: original.submissionId });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The batch member is unavailable.');
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  const parent = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId });
  const { deferredCheck: _deferred, ...pins } = original;
  void _deferred;
  const attempt = {
    ...pins,
    ...(input.main ? { main: input.main } : {}),
    operations: {
      ...pins.operations,
      ...(parent.id !== original.id ? { accept: crypto.randomUUID() } : {}),
      ...(input.checkOperationId ? { check: input.checkOperationId } : {}),
    },
    id: crypto.randomUUID(),
    parentAttemptId: parent.id,
    number: parent.number + 1,
    check: input.check,
    ...(input.candidate ? { candidate: input.candidate, memberCandidate: original.candidate } : {}),
  };
  await insertLandingAttempt(ctx, attempt);
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

/** Main moved, not a check failure: retain the cohort and create one new exact
 * shared source/check generation. Late uploads retain their old operation pins. */
export async function retryLandingBatch(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  const { uploads: _uploads, runId: _run, included: _included, ...retained } = batch;
  void _uploads;
  void _run;
  void _included;
  await writeBatch(
    ctx,
    input,
    {
      ...retained,
      composeOperationId: crypto.randomUUID(),
      checkOperationId: crypto.randomUUID(),
      phase: 'composing',
      uploadIndex: 0,
    },
    true,
  );
  for (const member of batch.members) {
    const { row, state } = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: member.submissionId,
    });
    await writeLanding(
      ctx,
      row,
      {
        ...state,
        version: state.version + 1,
        phase: 'queued',
        observation: landingObservation('queued'),
        error: null,
        timing: { submittedAt: state.at, composeStartedAt: new Date().toISOString() },
      },
      false,
    );
  }
  await wakeBatch(ctx, input);
}
