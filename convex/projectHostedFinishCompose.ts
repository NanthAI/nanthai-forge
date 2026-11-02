import { candidateOwnerInputs } from './projectHostedProvenance';
import { semanticPayload } from '../src/semantic-payload';
import { mainSemanticMembers, mergeSemanticMembers, semanticBaseSequence } from './projectSemanticContracts';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { hostedStartMain } from './projectHostedChannels';
import { beginHostedOperation } from './projectHostedOperations';
import { composeRow, loadCompose, type ComposeState } from './projectHostedComposeStore';
import { saveObject } from './projectHostedSaveStore';
import {
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
  writeLanding,
  retainLandingProgress,
  type LandingIdentity,
} from './projectHostedLandingStore';
import { pinLandingAttempt } from './projectHostedLandingPins';
import { wakeLandingQueue, releaseLandingQueue } from './projectHostedLandingWake';
import { landingQueue } from './projectHostedLandingStore';
import { writeFinish, failFinish } from './projectHostedFinishStore';
import { scheduleFinish, wakeLandingOrderWaiters } from './projectHostedFinishWake';
import { hostedFinishBackoff, type HostedFinish } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { hostedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import { validCrossHeadProof, type CrossHeadProof } from '../src/hosted-cross-head-proof';
import { invalidatePipeline } from './projectHostedLandingPipeline';
import { scopedRecheckBasis } from './projectHostedScopedRecheck';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
async function wakeAfterPrecompose(
  ctx: MutationCtx,
  projectId: Doc<'projectHostedFinishes'>['projectId'],
  submissionId: string,
  runnable: boolean,
) {
  const input = { projectId, channel: 'main' as const };
  const queue = await landingQueue(ctx, input);
  if (queue?.lease?.submissionId === submissionId) await releaseLandingQueue(ctx, queue);
  else if (runnable) await wakeLandingQueue(ctx, input);
}
/** Consume only a committed main event retained while this job was running.
 * Repeated events occupy one slot; job completion, never an idle timer, resumes
 * the latest observed main unless an ordinary claim has already taken source
 * ownership. Reservation and settlement share this mutation. */
async function continuePrecompose(ctx: MutationCtx, row: Doc<'projectHostedFinishes'>, value: HostedFinish) {
  const probe = value.pending?.precompose;
  if (!probe?.next) return false;
  const { next, ...context } = probe;
  await reserveFinishRetry(
    ctx,
    (await ctx.db.get(row._id))!,
    { ...value, pending: null },
    'CHECK_EVIDENCE_REFRESH',
    { ...context, peerLanes: [...new Set([...context.peerLanes, ...next.peerLanes])] },
    { head: next.main.head, receipt: { id: next.main.receiptId } },
  );
  return true;
}
/** A main race is not a retry of the old request or a reusable check. Retain a
 * named child before IO, yield with bounded backoff, and resume that child only. */
export async function reserveFinishRetry(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  value: HostedFinish,
  cause: 'BATCH_FALLBACK' | 'CHECK_EVIDENCE_REFRESH' = 'CHECK_EVIDENCE_REFRESH',
  precompose?: NonNullable<HostedFinish['pending']>['precompose'],
  observedMain?: { head: string; receipt: { id: string } },
) {
  invariant(!value.pending, 'WORK_STALE', 'Resume the already pending finish attempt.');
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const { row: landing, state } = await loadLanding(ctx, input);
  const previous = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  const main = observedMain ?? (await hostedStartMain(ctx, row.projectId));
  const cached =
    !precompose &&
    value.precomposed &&
    canonicalPayload(value.precomposed.main) ===
      canonicalPayload({ head: main.head, receiptId: main.receipt.id })
      ? value.precomposed
      : undefined;
  // A useful claim may adopt the exact in-flight advisory source operation.
  // Batch fallback can rotate metadata attempts without changing this finish's
  // immutable original selection. Its same-main source cache remains valid;
  // installation independently checks exact input/dependency roots below.
  const pending = {
    ...(precompose ? { precompose } : {}),
    id: crypto.randomUUID(),
    parentAttemptId: previous.id,
    number: previous.number + 1,
    at: new Date(Date.now()).toISOString(),
    main: { head: main.head, receiptId: main.receipt.id },
    operations: {
      compose: cached?.operationId ?? crypto.randomUUID(),
      check: crypto.randomUUID(),
      accept: crypto.randomUUID(),
    },
  };
  const mainChanged = main.head !== previous.main.head || main.receipt.id !== previous.main.receiptId;
  if (!precompose)
    await retainLandingProgress(ctx, state, {
      code: mainChanged ? 'CHANNEL_CHANGED' : cause,
      message: mainChanged
        ? `${await mainMoveReason(ctx, row.projectId, previous, main.head, state.sequence)}; a named child recomposes the original selection.`
        : cause === 'BATCH_FALLBACK'
          ? 'The shared batch fell back to an individual Candidate; main did not change.'
          : 'The acceptance evidence needs an exact refresh; main did not change.',
    });
  const retiringSolo =
    !precompose && !state.batchId && (state.phase === 'checking' || state.phase === 'ready');
  if (retiringSolo && landing.pipelineRetiredAttemptId !== state.attemptId)
    await invalidatePipeline(
      ctx,
      { projectId: row.projectId, batchId: state.id },
      { members: [{ submissionId: state.id }] },
    );
  await writeFinish(ctx, row, { ...value, pending });
  if (!precompose)
    await writeLanding(
      ctx,
      retiringSolo ? { ...landing, pipelineRetiredAttemptId: state.attemptId } : landing,
      {
        ...state,
        version: state.version + 1,
        timing: { submittedAt: state.at, ...state.timing, composeStartedAt: pending.at },
        observation: landingObservation('queued'),
        error: null,
      },
      false,
    );
  if (retiringSolo && landing.orderWaited) await wakeLandingOrderWaiters(ctx, landing, true);
  const current = (await ctx.db.get(row._id))!;
  await scheduleFinish(ctx, current, precompose ? 0 : hostedFinishBackoff(pending.number));
}
/** Why this re-check happens: the landings that moved main since the stale
 * attempt was composed, and whether each was submitted before this one. One
 * indexed window of recent landings, read only when a re-check starts. */
async function mainMoveReason(
  ctx: MutationCtx,
  projectId: Doc<'projectHostedFinishes'>['projectId'],
  previous: { at: string; main: { head: string } },
  head: string,
  sequence: number,
) {
  const landed = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q.eq('projectId', projectId).eq('channel', 'main').eq('phase', 'landed'),
    )
    .order('desc')
    .take(8);
  const movers = landed
    .map(row => hostedLandingStateSchema.parse(JSON.parse(row.value)))
    .filter(s => Date.parse(s.timing?.committedAt ?? '') > Date.parse(previous.at))
    .sort((a, b) => a.sequence - b.sequence);
  const moved = `Main moved from ${previous.main.head.slice(0, 8)} to ${head.slice(0, 8)}`;
  if (!movers.length) return `${moved} outside the landing queue`;
  const named = (list: typeof movers) =>
    list.map(s => `#${s.sequence} (${s.operationId.slice(0, 8)})`).join(', ');
  const before = movers.filter(s => s.sequence < sequence),
    after = movers.filter(s => s.sequence > sequence);
  return [
    moved,
    ...(before.length ? [`${named(before)} landed, submitted before this one`] : []),
    ...(after.length ? [`${named(after)} landed, submitted after this one`] : []),
  ].join('; ');
}
/** Reuse trusted immutable selection roots, never re-read current Lane heads.
 * H08 already staged these pages and validated every entry before its first job. */
export async function prepareFinishCompose(ctx: MutationCtx, input: LandingIdentity, value: HostedFinish) {
  const { state } = await loadLanding(ctx, input),
    pending = value.pending!;
  const auth = { projectId: input.projectId, actor: state.actor, operationId: pending.operations.compose };
  const old = await composeRow(ctx, auth);
  if (old) return loadCompose(ctx, auth, true, old);
  const request = { ...value.source, operationId: auth.operationId, expectedMain: pending.main };
  const expected = { authorityEpoch: request.authorityEpoch, ...request.expectedMain };
  const prepared = await beginHostedOperation(ctx, {
    ...auth,
    payload: request,
    request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
    firstAttempt: {
      projectId: input.projectId,
      operationId: auth.operationId,
      id: pending.id,
      parentAttemptId: null,
      at: pending.at,
      expected,
      ids: { candidate: crypto.randomUUID(), job: crypto.randomUUID(), jobOperation: crypto.randomUUID() },
    },
  });
  invariant(!prepared.replayed, 'SOURCE_UNAVAILABLE', 'The pending source operation lost its composition.');
  const originalRow = await readHostedRecord(ctx, {
    ...auth,
    kind: 'candidate',
    key: state.request.candidateId,
  });
  const originalCandidate = originalRow
    ? hostedRecordSchema.options[3].parse(JSON.parse(originalRow.value))
    : null;
  const peers = await mainSemanticMembers(ctx, auth, pending.main.receiptId);
  const semanticPlan = mergeSemanticMembers(
    request.intentId,
    originalCandidate?.semanticPlan?.members,
    peers,
  );
  if (semanticPlan.members.length) {
    const ownRow = await readHostedRecord(ctx, { ...auth, kind: 'intent', key: request.intentId });
    const own = ownRow ? hostedRecordSchema.options[0].parse(JSON.parse(ownRow.value)) : null;
    semanticPlan.afterSequence =
      originalCandidate?.semanticPlan?.afterSequence ??
      (own ? await semanticBaseSequence(ctx, input.projectId, own.base.receiptId) : 0);
  }
  const project = await hostedWriteProject(ctx, input.projectId, state.actor, request.authorityEpoch);
  const stateValue: ComposeState = {
    ownerProvenance: 1,
    ...(value.restoreBases ? { restoreBases: value.restoreBases } : {}),
    ownerInputs: Boolean(
      originalRow &&
      originalCandidate &&
      candidateOwnerInputs(project, originalRow, originalCandidate, request.authorityEpoch),
    ),
    ...(semanticPlan.members.length ? { semanticPlan } : {}),
    request,
    main: await saveObject(ctx, input.projectId, { sha256: pending.main.head }),
    inputs: { next: null, pages: request.inputs.pages, count: request.inputs.count },
    dependencies: { next: null, pages: request.dependencies.pages, count: request.dependencies.count },
    candidateId: prepared.operation.firstAttempt.ids.candidate!,
    jobOperationId: prepared.operation.firstAttempt.ids.jobOperation!,
    status: 'ready',
  };
  const fields = {
    ...auth,
    jobId: prepared.operation.firstAttempt.ids.job!,
    value: semanticPayload(stateValue),
  };
  const id = await ctx.db.insert('projectHostedComposes', fields);
  // These records and the authority check were produced in this transaction.
  // Do not reload the same compose, operation and project just to return them.
  return { row: (await ctx.db.get(id))!, state: stateValue, project, operation: prepared.operation };
}
export async function installFinishCompose(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  value: HostedFinish,
  proof?: CrossHeadProof,
  preparedSource?: Awaited<ReturnType<typeof loadCompose>>,
) {
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const { row: landing, state } = await loadLanding(ctx, input),
    pending = value.pending!;
  const source =
    preparedSource ??
    (await loadCompose(ctx, {
      projectId: row.projectId,
      actor: state.actor,
      operationId: pending.operations.compose,
    }));
  if (
    pending.precompose &&
    (state.phase === 'landed' ||
      state.phase === 'terminal-failed' ||
      pending.parentAttemptId !== state.attemptId ||
      (state.batchId && landing.runId))
  ) {
    // The shared exact generation now owns this member. A late individual
    // probe cannot replace its check, head or terminal result.
    await writeFinish(ctx, row, { ...value, pending: null });
    await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
    return;
  }
  const terminal = source.operation.terminal;
  invariant(terminal, 'WORK_STALE', 'Wait for the original source job to settle.');
  if (terminal.outcome.status === 'failed') {
    if (pending.precompose) {
      if (await continuePrecompose(ctx, row, value)) return;
      // Speculative infrastructure failure is not a source conflict. Let the
      // ordinary queue retry on demand, without an idle probe retry loop.
      await writeFinish(ctx, row, { ...value, pending: null });
      if (pending.precompose.runnable && !landing.runnable)
        await ctx.db.patch(landing._id, { runnable: true });
      await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
      await wakeAfterPrecompose(
        ctx,
        row.projectId,
        state.id,
        pending.precompose.runnable || landing.runnable,
      );
    } else if (value.precomposed?.operationId === pending.operations.compose) {
      // Reusing a probe transfers source ownership, never its speculative
      // infrastructure failure. The ordinary claim gets its own fresh compose.
      const { precomposed: _probe, ...ordinary } = value;
      void _probe;
      await reserveFinishRetry(ctx, row, { ...ordinary, pending: null });
    } else await failFinish(ctx, input, terminal.outcome.error.code, terminal.outcome.error.message);
    return;
  }
  const candidate = hostedRecordSchema.parse(terminal.outcome.result);
  invariant(
    candidate.kind === 'candidate' &&
      candidate.id === source.state.candidateId &&
      canonicalPayload(candidate.base) === canonicalPayload(pending.main) &&
      canonicalPayload(candidate.inputs) === canonicalPayload(value.source.inputs.root) &&
      canonicalPayload(candidate.dependencies) === canonicalPayload(value.source.dependencies.root),
    'WORK_OPERATION_CHANGED',
    'The named recompose changed the original exact selection.',
  );
  if (pending.precompose) {
    const obsoleteConflict =
      candidate.result.status === 'conflict' &&
      (await hostedStartMain(ctx, row.projectId)).head !== pending.main.head;
    // A real earlier conflict may already have disappeared on accepted main.
    // Retain its artifact, but let the latest notified source job (or ordinary
    // current-head controller) decide before publishing a terminal outcome.
    if (obsoleteConflict && (await continuePrecompose(ctx, row, value))) return;
    // A probe never reserves a check or replaces shared batch membership. Keep
    // a clean result for an ordinary retry; a real conflict settles immediately.
    await writeFinish(ctx, row, {
      ...value,
      pending: null,
      ...(candidate.result.status === 'clean'
        ? {
            precomposed: {
              operationId: pending.operations.compose,
              parentAttemptId: pending.parentAttemptId,
              main: pending.main,
            },
          }
        : {}),
    });
    if (candidate.result.status === 'conflict' && !obsoleteConflict) {
      // Terminal readers must select this exact conflict, never the earlier
      // clean Candidate whose immutable inputs the probe recomposed. Pin its
      // child attempt without allocating a check or replacing batch membership.
      const original = await loadLandingAttempt(ctx, {
        projectId: row.projectId,
        attemptId: state.firstAttemptId,
      });
      const attempt = await pinLandingAttempt(ctx, {
        ...input,
        actor: original.actor,
        deferCheck: false,
        request: {
          ...state.request,
          expectedMain: pending.main,
          candidateId: candidate.id,
          expectedHead: null,
          check: null,
        },
        attemptId: pending.id,
        parentAttemptId: pending.parentAttemptId,
        number: pending.number,
        at: pending.at,
        operations: { check: pending.operations.check, accept: pending.operations.accept },
        retainedSelection: original.candidate,
      });
      await insertLandingAttempt(ctx, attempt);
      await writeLanding(
        ctx,
        landing,
        { ...state, version: state.version + 1, attemptId: attempt.id },
        false,
      );
      const paths = source.state.conflictSummary?.paths ?? pending.precompose.paths;
      const more = source.state.conflictSummary?.more ?? 0;
      await failFinish(
        ctx,
        input,
        'COMPOSITION_CONFLICT',
        `Candidate ${candidate.id} conflicts in ${paths.join(', ')}${more ? ` (and ${more} more files in its retained conflict pages)` : ''} against main ${pending.main.head}${pending.precompose.peerLanes.length ? ` (accepted Lane(s) ${pending.precompose.peerLanes.join(', ')})` : ''}. Run nforge agent . sync '${JSON.stringify({ candidateId: candidate.id })}', resolve the files, then land again.`,
      );
      await wakeAfterPrecompose(ctx, row.projectId, state.id, true);
    } else {
      if (await continuePrecompose(ctx, row, value)) return;
      if (pending.precompose.runnable && !landing.runnable)
        await ctx.db.patch(landing._id, { runnable: true });
      if (!state.batchDiagnostic?.waitingFor) await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
      await wakeAfterPrecompose(
        ctx,
        row.projectId,
        state.id,
        pending.precompose.runnable || landing.runnable,
      );
    }
    return;
  }
  const original = await loadLandingAttempt(ctx, {
    projectId: row.projectId,
    attemptId: state.firstAttemptId,
  });
  const previous = pending.parentAttemptId
    ? await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: pending.parentAttemptId })
    : null;
  if (proof && previous?.check && previous.candidate.head) {
    const checked = previous.crossHeadProof?.checked ?? previous.candidate;
    const checkedBase = previous.crossHeadProof?.checkedBase ?? previous.main;
    invariant(
      validCrossHeadProof(proof) &&
        proof.checked.id === checked.id &&
        proof.checked.head === checked.head &&
        proof.checked.digest === checked.digest &&
        canonicalPayload(proof.checkedBase) === canonicalPayload(checkedBase) &&
        canonicalPayload(proof.main) === canonicalPayload(pending.main) &&
        candidate.result.status === 'clean' &&
        proof.head === candidate.result.head &&
        proof.runId === previous.check.runId,
      'EVIDENCE_CHANGED',
      'Reuse only the exact verified recomposition proof.',
    );
    const run = await requireHostedCheckEvidence(ctx, {
      projectId: row.projectId,
      actor: previous.actor.id,
      candidateId: checked.id,
      head: checked.head!,
      authorityEpoch: previous.authorityEpoch,
      ...previous.check,
    });
    invariant(
      run.terminalDigest === proof.terminalDigest &&
        run.planDigest === proof.planDigest &&
        run.plan?.selection.sha256 === proof.checkedSelection,
      'EVIDENCE_CHANGED',
      'The original check proof changed.',
    );
  } else proof = undefined;
  // A main race without a transferable proof may recheck only the shared impact.
  const recheck =
    !proof && previous && candidate.result.status === 'clean'
      ? await scopedRecheckBasis(ctx, previous)
      : undefined;
  const attempt = await pinLandingAttempt(ctx, {
    ...(recheck ? { recheck } : {}),
    ...input,
    actor: original.actor,
    deferCheck: proof ? false : !state.batchSolo,
    request: {
      ...state.request,
      expectedMain: pending.main,
      candidateId: candidate.id,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      check: proof ? null : value.check,
    },
    attemptId: pending.id,
    parentAttemptId: pending.parentAttemptId,
    number: pending.number,
    at: pending.at,
    operations: { check: pending.operations.check, accept: pending.operations.accept },
    retainedSelection: original.candidate,
  });
  if (proof && previous?.check) {
    attempt.check = previous.check;
    attempt.crossHeadProof = proof;
  }
  await insertLandingAttempt(ctx, attempt);
  await writeFinish(ctx, row, { ...value, pending: null });
  const { batchNeedsSoloCompose: _needsSolo, ...installedState } = state;
  void _needsSolo;
  await writeLanding(
    ctx,
    landing,
    {
      ...installedState,
      version: state.version + 1,
      attemptId: attempt.id,
      phase: 'queued',
      timing: { submittedAt: state.at, composeStartedAt: pending.at, composedAt: new Date().toISOString() },
      observation: landingObservation('queued'),
      error: null,
    },
    true,
  );
  await wakeLandingQueue(ctx, { projectId: row.projectId, channel: 'main' });
}
