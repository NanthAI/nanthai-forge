// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { requireLandingLease, type LandingClaim } from './projectHostedLandingControl';
import { loadBatch, writeBatch, wakeBatch, retryLandingBatch } from './projectHostedLandingBatchStore';
import {
  loadLanding,
  loadLandingAttempt,
  writeLanding,
  settleLandingOperation,
} from './projectHostedLandingStore';
import { acceptancePlan, acceptanceRow, acceptanceSelection } from './projectHostedAcceptanceStore';
import { releaseLandingQueue } from './projectHostedLandingWake';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { channelRow } from './projectHostedChannels';
import { saveObject } from './projectHostedSaveStore';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { scheduleAcceptanceCompletion } from './projectHostedAcceptanceCompletion';
import { noteMainLanding } from './projectHostedMainAuditState';
import { enqueueGithubMirror } from './projectGithubMirrorQueue';
import { hostedMainV2Schema } from '../src/hosted-main';
import { hostedRecordSchema } from '../src/hosted-records';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { effectivePolicy } from '../src/autonomy-policy';
import { batchEligible } from '../src/hosted-landing-batch';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { landingObservation } from '../src/hosted-landing';
import { invariant } from '../src/errors';

/** At most eight independently authorized members, one checked head, one main
 * CAS. All receipts, request settlements and completion activations commit with
 * that CAS. No intermediate/unchecked prefix is ever published. */
export async function publishLandingBatch(ctx: MutationCtx, claim: LandingClaim, now = Date.now()) {
  const selected = await acceptanceSelection(ctx, claim);
  const old = await acceptanceRow(ctx, {
    projectId: claim.projectId,
    receiptId: selected.attempt.operations.accept,
  });
  if (old) return { status: 'landed' as const, receipt: hostedAcceptanceSchema.parse(JSON.parse(old.value)) };
  const { state, attempt, queue } = await requireLandingLease(ctx, claim, now);
  invariant(state.batchId && !state.batchSolo, 'WORK_STALE', 'Select the prepared shared batch.');
  const key = { projectId: claim.projectId, batchId: state.batchId };
  const { batch } = await loadBatch(ctx, key);
  const included = batch.members.filter(m => !batch.included || batch.included.includes(m.submissionId));
  const members = [];
  for (const original of included) {
    const current = await loadLanding(ctx, {
      projectId: claim.projectId,
      submissionId: original.submissionId,
    });
    if (current.state.phase === 'terminal-failed') {
      await writeBatch(ctx, key, { ...batch, phase: 'fallback' });
      await releaseLandingQueue(ctx, queue, now);
      await wakeBatch(ctx, key);
      return { status: 'pending' as const, reason: 'Batch changed; exact single checks are queued.' };
    }
    if (current.state.phase !== 'ready') {
      await releaseLandingQueue(ctx, queue, now);
      return { status: 'pending' as const, reason: 'Batch members are preparing acceptance.' };
    }
    const pins = await loadLandingAttempt(ctx, {
      projectId: claim.projectId,
      attemptId: current.state.attemptId,
    });
    invariant(
      current.state.batchId === batch.id &&
        !current.state.batchSolo &&
        canonicalPayload(pins.memberCandidate) === canonicalPayload(original.candidate) &&
        canonicalPayload(pins.main) === canonicalPayload(attempt.main) &&
        canonicalPayload(pins.candidate) === canonicalPayload(attempt.candidate) &&
        canonicalPayload(pins.check) === canonicalPayload(attempt.check),
      'EVIDENCE_CHANGED',
      'Batch membership or shared evidence changed.',
    );
    const plan = await acceptancePlan(ctx, { projectId: claim.projectId, receiptId: pins.operations.accept });
    if (!plan || plan.inputsNext !== null || plan.dependenciesNext !== null) {
      await releaseLandingQueue(ctx, queue, now);
      return { status: 'pending' as const, reason: 'Batch members are staging completion evidence.' };
    }
    invariant(
      plan.attemptId === pins.id && plan.submissionId === current.state.id,
      'EVIDENCE_CHANGED',
      'The member completion plan differs.',
    );
    members.push({ ...current, attempt: pins, original, plan });
  }
  const project = await hostedWriteProject(ctx, claim.projectId, attempt.actor.id, attempt.authorityEpoch);
  const channel = await channelRow(ctx, claim.projectId);
  invariant(channel, 'SOURCE_UNAVAILABLE', 'Authoritative main is unavailable.');
  const main = hostedMainV2Schema.parse(JSON.parse(channel.selection));
  invariant(
    project.sourceAuthority?.mode === 'server' &&
      main.authority.mode === 'server' &&
      main.projectId === claim.projectId &&
      main.authority.epoch === attempt.authorityEpoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Current main source authority differs.',
  );
  const policy = effectivePolicy(project),
    policyDigest = digest(canonicalPayload(policy));
  const candidateRow = await readHostedRecord(ctx, {
    projectId: claim.projectId,
    actor: attempt.actor.id,
    kind: 'candidate',
    key: attempt.candidate.id,
  });
  invariant(
    candidateRow?.digest === attempt.candidate.digest,
    'EVIDENCE_CHANGED',
    'The stacked Candidate changed.',
  );
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(candidateRow.value));
  invariant(
    candidate.result.status === 'clean' &&
      candidate.result.head === attempt.candidate.head &&
      canonicalPayload(candidate.base) === canonicalPayload(attempt.main) &&
      canonicalPayload(candidate.inputs) === canonicalPayload(attempt.candidate.inputs) &&
      canonicalPayload(candidate.dependencies) === canonicalPayload(attempt.candidate.dependencies),
    'EVIDENCE_CHANGED',
    'Publish only the exact checked stacked Candidate.',
  );
  const mainChanged = candidate.base.head !== main.head || candidate.base.receiptId !== main.receipt.id;
  let retry = false;
  for (const member of members) {
    await hostedWriteProject(ctx, claim.projectId, member.attempt.actor.id, member.attempt.authorityEpoch);
    const own = await readHostedRecord(ctx, {
      projectId: claim.projectId,
      actor: member.attempt.actor.id,
      kind: 'candidate',
      key: member.original.candidate.id,
    });
    invariant(
      own?.digest === member.original.candidate.digest,
      'EVIDENCE_CHANGED',
      'A batch member Candidate changed.',
    );
    const originalCandidate = hostedRecordSchema.options[3].parse(JSON.parse(own.value));
    retry ||=
      member.attempt.policyDigest !== policyDigest ||
      !batchEligible(project, policy, member.attempt.actor, originalCandidate);
  }
  if (mainChanged && !retry && members.length === batch.members.length) {
    await retryLandingBatch(ctx, key, batch);
    await releaseLandingQueue(ctx, queue, now);
    return {
      status: 'pending' as const,
      reason: 'Main changed; the cohort is recomposing one exact shared check.',
    };
  }
  if (retry || mainChanged) {
    await writeBatch(ctx, key, { ...batch, phase: 'fallback' });
    await releaseLandingQueue(ctx, queue, now);
    await wakeBatch(ctx, key);
    return {
      status: 'pending' as const,
      reason: 'Main or governance changed; exact single checks are queued.',
    };
  }
  const head = candidate.result.head;
  const registered = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q => q.eq('projectId', claim.projectId).eq('head', head))
    .unique();
  const source = await saveObject(ctx, claim.projectId, { sha256: head });
  invariant(
    registered && registered.size === source.object.size,
    'SOURCE_HASH_MISMATCH',
    'Registered batch source differs.',
  );
  invariant(
    attempt.check && batch.runId === attempt.check.runId,
    'CHECK_NOT_PASSED',
    'A batch needs its exact shared run.',
  );
  const run = await requireHostedCheckEvidence(ctx, {
    projectId: claim.projectId,
    actor: attempt.actor.id,
    candidateId: candidate.id,
    head,
    authorityEpoch: attempt.authorityEpoch,
    ...attempt.check,
  });
  invariant(
    run.candidate.digest === candidateRow.digest && run.gate?.mode === 'full',
    'EVIDENCE_CHANGED',
    'The batch needs full-gate evidence for this exact Candidate.',
  );
  const check = {
    ...attempt.check,
    terminalDigest: run.terminalDigest!,
    planDigest: run.planDigest!,
    executionId: run.executionId!,
    ...(run.macEvidence ? { macEvidence: run.macEvidence } : {}),
  };
  let previousSnapshot = main.snapshotId;
  const receipts = [];
  for (const [index, member] of members.entries()) {
    const receipt = hostedAcceptanceSchema.parse({
      schema: 1,
      id: member.attempt.operations.accept,
      projectId: claim.projectId,
      channel: 'main',
      submissionId: member.state.id,
      operationId: member.state.operationId,
      attemptId: member.attempt.id,
      at: new Date(now).toISOString(),
      authorityEpoch: member.attempt.authorityEpoch,
      previous: candidate.base,
      candidate: member.attempt.candidate,
      memberCandidate: member.original.candidate,
      batchId: batch.id,
      actor: member.attempt.actor,
      policyDigest,
      check,
      snapshot: {
        id: member.attempt.operations.accept,
        previousId: previousSnapshot,
        revision: main.sourceRevision + index + 1,
      },
      completion: {
        root: member.plan.root,
        pages: member.plan.inputPages,
        lanes: member.plan.lanes,
        enabled: policy.lifecycle.completeOnAccept && !member.state.request.keepOpen,
      },
      automatic: true,
      undo: { kind: 'revert', receiptId: member.attempt.operations.accept },
    });
    const identity = { projectId: claim.projectId, receiptId: receipt.id },
      value = canonicalPayload(receipt);
    await ctx.db.insert('projectHostedAcceptances', {
      ...identity,
      submissionId: member.state.id,
      attemptId: member.attempt.id,
      sequence: receipt.snapshot.revision,
      value,
    });
    await ctx.db.insert('projectHostedAcceptanceEvents', {
      ...identity,
      sequence: receipt.snapshot.revision,
      value,
    });
    await ctx.db.insert('projectHostedAcceptanceSnapshots', {
      projectId: claim.projectId,
      snapshotId: receipt.snapshot.id,
      previousId: previousSnapshot,
      receiptId: receipt.id,
      sourceRevision: receipt.snapshot.revision,
      head,
    });
    previousSnapshot = receipt.snapshot.id;
    const next = {
      ...member.state,
      version: member.state.version + 1,
      phase: 'landed' as const,
      acceptance: { receiptId: receipt.id, head },
      observation: landingObservation('accepted'),
      error: null,
    };
    await writeLanding(ctx, member.row, next, false);
    await settleLandingOperation(ctx, next);
    if (receipt.completion.enabled && member.plan.inputPages)
      await scheduleAcceptanceCompletion(ctx, identity);
    receipts.push(receipt);
  }
  const last = receipts.at(-1)!;
  await ctx.db.patch(channel._id, {
    operationId: last.id,
    selection: canonicalPayload(
      hostedMainV2Schema.parse({
        ...main,
        head,
        snapshotId: last.snapshot.id,
        sourceRevision: last.snapshot.revision,
        receipt: { id: last.id, kind: 'server', previousHead: main.head, previousReceiptId: main.receipt.id },
      }),
    ),
  });
  await writeBatch(ctx, key, { ...batch, phase: 'landed' });
  await releaseLandingQueue(ctx, queue, now);
  await noteMainLanding(ctx, { project, receipt: last, run });
  await enqueueGithubMirror(ctx, project, last);
  return { status: 'landed' as const, receipt: receipts.find(r => r.submissionId === state.id)! };
}
