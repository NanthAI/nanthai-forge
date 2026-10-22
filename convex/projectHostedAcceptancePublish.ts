// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { activeProject } from './projectAuthority';
import { requireLandingLease, type LandingClaim } from './projectHostedLandingControl';
import { writeLanding, settleLandingOperation } from './projectHostedLandingStore';
import { releaseLandingQueue } from './projectHostedLandingWake';
import { acceptanceSelection, acceptanceRow, acceptancePlan } from './projectHostedAcceptanceStore';
import { channelRow } from './projectHostedChannels';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { saveObject } from './projectHostedSaveStore';
import { scheduleAcceptanceCompletion } from './projectHostedAcceptanceCompletion';
import { hostedMainV2Schema } from '../src/hosted-main';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy, reviewReason } from '../src/autonomy-policy';
import { landingObservation } from '../src/hosted-landing';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
/** One constant-size publication transaction. A completed replay authorizes the
 * reader first, then returns the original receipt without rechecking old policy,
 * acquiring another lease or rewinding any later main/saved Lane. */
export async function publishAcceptance(ctx: MutationCtx, claim: LandingClaim, now = Date.now()) {
  const selected = await acceptanceSelection(ctx, claim);
  await activeProject(ctx, claim.projectId, selected.attempt.actor.id);
  const identity = { projectId: claim.projectId, receiptId: selected.attempt.operations.accept };
  const old = await acceptanceRow(ctx, identity);
  if (old) {
    const receipt = hostedAcceptanceSchema.parse(JSON.parse(old.value));
    invariant(
      receipt.attemptId === claim.attemptId && receipt.submissionId === claim.submissionId,
      'WORK_OPERATION_CHANGED',
      'Replay the original accepted attempt.',
    );
    return { status: 'landed' as const, receipt };
  }
  const { row, state, attempt, queue } = await requireLandingLease(ctx, claim, now);
  invariant(state.phase === 'ready', 'WORK_STALE', 'Only the prepared exact attempt can publish.');
  const project = await hostedWriteProject(ctx, claim.projectId, attempt.actor.id, attempt.authorityEpoch);
  invariant(
    project.sourceAuthority?.mode === 'server',
    'SOURCE_AUTHORITY_CHANGED',
    'Only current server authority can publish hosted main; shadow preparation does not accept source.',
  );
  const channel = await channelRow(ctx, claim.projectId);
  invariant(channel, 'SOURCE_UNAVAILABLE', 'Authoritative hosted main is unavailable.');
  const main = hostedMainV2Schema.parse(JSON.parse(channel.selection));
  invariant(
    main.projectId === claim.projectId &&
      main.authority.mode === 'server' &&
      main.authority.epoch === attempt.authorityEpoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Channel and project source authority differ.',
  );
  invariant(
    main.head === attempt.main.head && main.receipt.id === attempt.main.receiptId,
    'CHANNEL_CHANGED',
    'Main head or receipt changed; retain this attempt and prepare a named retry.',
  );
  const policy = effectivePolicy(project);
  invariant(
    digest(canonicalPayload(policy)) === attempt.policyDigest,
    'POLICY_CHANGED',
    'Current landing policy differs from the pinned attempt.',
  );
  const candidateRow = await readHostedRecord(ctx, {
    projectId: claim.projectId,
    actor: attempt.actor.id,
    kind: 'candidate',
    key: attempt.candidate.id,
  });
  invariant(
    candidateRow?.digest === attempt.candidate.digest,
    'EVIDENCE_CHANGED',
    'The exact canonical Candidate differs.',
  );
  const candidate = hostedRecordSchema.parse(JSON.parse(candidateRow.value));
  invariant(
    candidate.kind === 'candidate' &&
      candidate.result.status === 'clean' &&
      candidate.result.head === attempt.candidate.head &&
      candidate.base.head === main.head &&
      candidate.base.receiptId === main.receipt.id &&
      canonicalPayload(candidate.inputs) === canonicalPayload(attempt.candidate.inputs) &&
      canonicalPayload(candidate.dependencies) === canonicalPayload(attempt.candidate.dependencies),
    'EVIDENCE_CHANGED',
    'Accept only the original clean Candidate composed on the current main receipt.',
  );
  const head = candidate.result.head;
  const registered = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q => q.eq('projectId', claim.projectId).eq('head', head))
    .unique();
  invariant(registered, 'SOURCE_UNAVAILABLE', 'Accepted source requires trusted registration.');
  const source = await saveObject(ctx, claim.projectId, { sha256: head });
  invariant(
    source.object.size === registered.size,
    'SOURCE_HASH_MISMATCH',
    'Registered accepted source size differs.',
  );
  const plan = await acceptancePlan(ctx, identity);
  invariant(
    plan &&
      plan.attemptId === attempt.id &&
      plan.submissionId === state.id &&
      plan.inputsNext === null &&
      plan.dependenciesNext === null,
    'WORK_STALE',
    'Stage the complete immutable inclusion/completion plan before publication.',
  );
  let check = null;
  if (attempt.check) {
    const run = await requireHostedCheckEvidence(ctx, {
      projectId: claim.projectId,
      actor: attempt.actor.id,
      candidateId: candidate.id,
      head,
      authorityEpoch: attempt.authorityEpoch,
      ...attempt.check,
    });
    invariant(
      run.candidate.digest === candidateRow.digest,
      'EVIDENCE_CHANGED',
      'The exact run selected another Candidate record.',
    );
    check = {
      ...attempt.check,
      terminalDigest: run.terminalDigest!,
      planDigest: run.planDigest!,
      executionId: run.executionId!,
    };
  }
  invariant(
    attempt.actor.kind === 'person' || check,
    'CHECK_NOT_PASSED',
    'Agent acceptance requires an exact passing check.',
  );
  // H08 does not yet publish trusted changed-path coverage. Existing policy
  // explicitly requires review when that coverage is unavailable; never trust
  // caller-supplied paths or treat missing graph edges as independence.
  const reason = reviewReason(policy, attempt.actor, null);
  if (reason) {
    const next = {
      ...state,
      version: state.version + 1,
      observation: landingObservation('waiting-for-review'),
      error: null,
    };
    await writeLanding(ctx, row, next, false);
    await releaseLandingQueue(ctx, queue, now);
    return { status: 'pending' as const, reason, request: next };
  }
  const receipt = hostedAcceptanceSchema.parse({
    schema: 1,
    id: identity.receiptId,
    projectId: claim.projectId,
    channel: claim.channel,
    submissionId: state.id,
    operationId: state.operationId,
    attemptId: attempt.id,
    at: new Date(now).toISOString(),
    authorityEpoch: attempt.authorityEpoch,
    previous: attempt.main,
    candidate: attempt.candidate,
    actor: attempt.actor,
    policyDigest: attempt.policyDigest,
    check,
    snapshot: { id: identity.receiptId, previousId: main.snapshotId, revision: main.sourceRevision + 1 },
    completion: {
      root: plan.root,
      pages: plan.inputPages,
      lanes: plan.lanes,
      enabled: policy.lifecycle.completeOnAccept,
    },
    automatic: attempt.actor.kind === 'agent',
    undo: { kind: 'revert', receiptId: identity.receiptId },
  });
  const value = canonicalPayload(receipt);
  await ctx.db.insert('projectHostedAcceptances', {
    ...identity,
    submissionId: state.id,
    attemptId: attempt.id,
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
    previousId: main.snapshotId,
    receiptId: receipt.id,
    sourceRevision: receipt.snapshot.revision,
    head,
  });
  await ctx.db.patch(channel._id, {
    operationId: attempt.operations.accept,
    selection: canonicalPayload(
      hostedMainV2Schema.parse({
        ...main,
        head,
        snapshotId: receipt.snapshot.id,
        sourceRevision: receipt.snapshot.revision,
        receipt: {
          id: receipt.id,
          kind: 'server',
          previousHead: main.head,
          previousReceiptId: main.receipt.id,
        },
      }),
    ),
  });
  const next = {
    ...state,
    version: state.version + 1,
    phase: 'landed' as const,
    acceptance: { receiptId: receipt.id, head },
    observation: landingObservation('accepted'),
    error: null,
  };
  await writeLanding(ctx, row, next, false);
  await settleLandingOperation(ctx, next);
  await releaseLandingQueue(ctx, queue, now);
  if (receipt.completion.enabled && plan.inputPages) await scheduleAcceptanceCompletion(ctx, identity);
  return { status: 'landed' as const, receipt };
}
