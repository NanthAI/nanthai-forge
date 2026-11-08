// SPDX-License-Identifier: Apache-2.0
import { releaseBatchMembers } from './projectHostedLandingBatchRelease';
import { orderHostedLandingRows } from './projectHostedLandingOrder';
import { pipelinePredecessor, invalidatePipeline } from './projectHostedLandingPipeline';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  hostedLandingAttemptSchema,
  hostedLandingStateSchema,
  landingObservation,
} from '../src/hosted-landing';
import { hostedBatching } from '../src/hosted-landing-batch';
import { cohortSize, hostedAdmission } from '../src/hosted-landing-admission';
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

export {
  batchSchema,
  batchRow,
  loadBatch,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchState';
import {
  batchSchema,
  loadBatch,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchState';
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
  if (['fallback', 'superseded', 'split', 'failed'].includes(batch.phase))
    await invalidatePipeline(ctx, input, batch);
  if (batch.phase === 'fallback' || batch.phase === 'landed') await releaseBatchMembers(ctx, input, batch);
  if (batch.phase === 'superseded') {
    const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    if (queue?.train?.some(id => batch.members.some(member => member.submissionId === id)))
      await ctx.db.patch(queue._id, {
        train: queue.train.filter(id => !batch.members.some(member => member.submissionId === id)),
      });
  }
}
export async function wakeBatch(ctx: MutationCtx, input: BatchIdentity) {
  const { batch } = await loadBatch(ctx, input);
  if (['landed', 'superseded', 'split', 'failed'].includes(batch.phase)) return;
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
  // Grouping policy is pinned; members share its digest.
  if (!hostedBatching(own.policy)) return false;
  const admission = hostedAdmission(own.policy),
    queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' }),
    limit = cohortSize(own.policy, queue?.checkHistory, admission);
  const predecessor = await pipelinePredecessor(ctx, { projectId: input.projectId, channel: 'main' });
  const windows = [selected.row];
  // Bounded indexed heads exclude already-selected groups. Never enumerate the
  // queue just to fill one cohort, even with thousands of retained submissions.
  for (const priority of selected.row.priority === 'urgent'
    ? (['urgent'] as const)
    : (['normal', undefined] as const)) {
    windows.push(
      ...(await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_channel_runnable_batchable_priority_sequence', q =>
          q
            .eq('projectId', input.projectId)
            .eq('channel', 'main')
            .eq('runnable', true)
            .eq('batchable', true)
            .eq('priority', priority),
        )
        .order('asc')
        .take(limit)),
    );
  }
  const ordered = orderHostedLandingRows([...new Map(windows.map(row => [row.submissionId, row])).values()]);
  const members = ordered
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
    .slice(0, limit);
  if (members.length < (predecessor ? 1 : 2) || !members.some(m => m.state.id === input.submissionId))
    return false;
  const batch: LandingBatch = {
    id: crypto.randomUUID(),
    leaderId: members[0]!.state.id,
    at: new Date(Date.now()).toISOString(),
    composeOperationId: crypto.randomUUID(),
    checkOperationId: crypto.randomUUID(),
    phase: 'composing',
    ...(predecessor ? { predecessor } : {}),
    members: members.map(m => m.attempt),
    ...(admission ? { admitted: members.every(m => m.row.admission?.status === 'passed') } : {}),
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
    /** A platform retry of the same generation keeps its reserved receipt, so
     * groups stacked on (head, receipt) stay valid (ea86f3fb). */
    keepReceipt?: boolean;
  },
) {
  const { original } = input;
  const row = await landingRow(ctx, { projectId: input.projectId, submissionId: original.submissionId });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The batch member is unavailable.');
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  const parent = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId });
  // A retry or cohort pin is a new attempt: it never inherits the original's race reasons (7c2e69e1).
  const { deferredCheck: _deferred, recheckReason: _reason, scopedFallback: _scoped, ...pins } = original;
  void [_deferred, _reason, _scoped];
  const attempt = {
    ...pins,
    ...(input.main ? { main: input.main } : {}),
    operations: {
      ...pins.operations,
      ...(input.keepReceipt
        ? { accept: parent.operations.accept }
        : parent.id !== original.id
          ? { accept: crypto.randomUUID() }
          : {}),
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
  await invalidatePipeline(ctx, input, batch);
  const live = [];
  for (const original of batch.members) {
    const current = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: original.submissionId,
    });
    if (current.state.batchId === batch.id && !['landed', 'terminal-failed'].includes(current.state.phase))
      live.push({ original, ...current });
  }
  if (!live.length) return writeBatch(ctx, input, { ...batch, phase: 'landed' });
  const {
    uploads: _uploads,
    runId: _run,
    included: _included,
    predecessor: _predecessor,
    ...retained
  } = batch;
  void _predecessor;
  void _uploads;
  void _run;
  void _included;
  await writeBatch(
    ctx,
    input,
    {
      ...retained,
      members: live.map(member => member.original),
      leaderId: live[0]!.state.id,
      composeOperationId: crypto.randomUUID(),
      checkOperationId: crypto.randomUUID(),
      phase: 'composing',
      uploadIndex: 0,
    },
    true,
  );
  for (const { row, state } of live) {
    // This exact prefix was retired. Its advisory must not survive recomposition.
    const current =
      row.wouldConflict && JSON.parse(row.wouldConflict).predecessor
        ? { ...row, wouldConflict: undefined }
        : row;
    await writeLanding(
      ctx,
      current,
      {
        ...state,
        version: state.version + 1,
        phase: 'queued',
        observation: landingObservation('queued'),
        error: null,
        timing: { submittedAt: state.at, composeStartedAt: new Date(Date.now()).toISOString() },
      },
      false,
    );
  }
  // A previous shared generation trimmed rejected members from the train.
  // Restore this live cohort in its original member order before any successor
  // can pin the new tail. Descendants were retired above, unrelated rows stay.
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  if (queue) {
    const train = queue.train ?? [];
    const members = new Set(batch.members.map(member => member.submissionId));
    const first = train.findIndex(id => members.has(id));
    const anchor = first < 0 ? train.indexOf(batch.predecessor?.submissionId ?? '') + 1 : first;
    const prefix = train.slice(0, anchor).filter(id => !members.has(id));
    const suffix = train.slice(anchor).filter(id => !members.has(id));
    await ctx.db.patch(queue._id, {
      train: [...prefix, ...live.map(member => member.state.id), ...suffix],
    });
  }
  await wakeBatch(ctx, input);
}
