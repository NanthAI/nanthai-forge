// SPDX-License-Identifier: Apache-2.0
import { settleBatchConflicts } from './projectHostedLandingCohortConflicts';
import { scheduleLandingPrecompose } from './projectHostedLandingPrecompose';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireLandingLease, type LandingClaim } from './projectHostedLandingControl';
import { loadBatch, writeBatch, wakeBatch, retryLandingBatch } from './projectHostedLandingBatchStore';
import {
  loadLanding,
  landingRow,
  loadLandingAttempt,
  writeLanding,
  settleLandingOperation,
} from './projectHostedLandingStore';
import {
  acceptancePlan,
  acceptanceRow,
  acceptanceSelection,
  type ReceiptIdentity,
} from './projectHostedAcceptanceStore';
import { releaseLandingQueue } from './projectHostedLandingWake';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { channelRow } from './projectHostedChannels';
import { saveObject } from './projectHostedSaveStore';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { hostedAcceptGate } from './projectHostedGate';
import { cohortRecheckBasis } from './projectHostedScopedRecheck';
import { scopedRecheckPairs } from '../src/scoped-recheck-policy';
import { scheduleAcceptanceCompletion } from './projectHostedAcceptanceCompletion';
import { noteMainLanding } from './projectHostedMainAuditState';
import { enqueueGithubMirror } from './projectGithubMirrorQueue';
import { hostedMainV2Schema } from '../src/hosted-main';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  hostedAcceptanceSchema,
  firstCheckField,
  orderWaitsField,
  firstCheckReceipt,
  landingCompletion,
} from '../src/hosted-acceptance';
import { effectivePolicy } from '../src/autonomy-policy';
import { batchEligible } from '../src/hosted-landing-batch';
import {
  approvalHoldReason,
  attemptApprovals,
  endLandedApprovals,
  liveApprovals,
} from './projectHostedApprovalStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { policyDigestCurrent } from '../src/policy-digest';
import { landingObservation } from '../src/hosted-landing';
import { landingAcceptedBy } from '../src/landing-accepted-by';
import { invariant } from '../src/errors';
import { acceptedLandingMessage } from './projectHostedLandingMessage';
import { alertSecretAllowAdded } from './projectHostedSecretAllow';
import { secretAllowMark } from '../src/secret-allow';
import { batchCoverageFailure } from './projectHostedBatchCoverage';
import type { BatchMemberPaths } from '../src/hosted-batch-coverage';
import { landingDocsUndo } from '../src/docs-resolution';

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
      await writeBatch(ctx, key, {
        ...batch,
        phase: 'fallback',
        transition: {
          code: 'BATCH_MEMBER_SETTLED',
          message: 'An included member settled before publication.',
        },
      });
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
  const policy = effectivePolicy(project);
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
  const memberPaths: BatchMemberPaths[] = [];
  // A member whose Lane waits on an owner approval request lands alone, where it holds (fe5bea80).
  const approvals = await liveApprovals(ctx, claim.projectId);
  const granted: Awaited<ReturnType<typeof attemptApprovals>> = [];
  const memberApprovals = async (receiptId: string) => {
    const matched = approvals.length
      ? await attemptApprovals(ctx, claim.projectId, receiptId, approvals)
      : [];
    granted.push(...matched);
    return matched;
  };
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
    memberPaths.push({
      submissionId: member.state.id,
      head: member.original.candidate.head ?? '',
      paths: originalCandidate.governance?.paths,
    });
    retry ||=
      !policyDigestCurrent(policy, member.attempt.policyDigest) ||
      !batchEligible(project, policy, member.attempt.actor, originalCandidate) ||
      approvalHoldReason(await memberApprovals(member.attempt.operations.accept)) !== null;
  }
  if (mainChanged && !retry && members.length === batch.members.length) {
    await retryLandingBatch(
      ctx,
      key,
      batch,
      await cohortRecheckBasis(ctx, batch.recheck, batch.runId, attempt),
    );
    await releaseLandingQueue(ctx, queue, now);
    return {
      status: 'pending' as const,
      reason: 'Main changed; the cohort is recomposing one exact shared check.',
    };
  }
  if (retry || mainChanged) {
    await writeBatch(ctx, key, {
      ...batch,
      phase: 'fallback',
      transition: {
        code: mainChanged ? 'CHANNEL_CHANGED' : 'EVIDENCE_CHANGED',
        message: mainChanged
          ? 'Main head or receipt changed before publication.'
          : 'Current member governance differs from the prepared batch.',
      },
    });
    await releaseLandingQueue(ctx, queue, now);
    await wakeBatch(ctx, key);
    return {
      status: 'pending' as const,
      reason: 'Main or governance changed; exact single checks are queued.',
    };
  }
  // Every receipt below says its member landed. A member the shared State does not provably
  // carry never publishes; the members land one by one with exact single checks instead.
  const gap = await batchCoverageFailure(ctx, {
    projectId: claim.projectId,
    head: candidate.result.head,
    base: candidate.base.head,
    shared: candidate.governance?.paths,
    members: memberPaths,
  });
  if (gap) {
    await writeBatch(ctx, key, {
      ...batch,
      phase: 'fallback',
      transition: {
        code: 'BATCH_MEMBER_UNPUBLISHED',
        message: gap.missing.length
          ? `The shared State lacks changed paths of member ${gap.submissionId}: ${gap.missing.join(', ')}${gap.more ? ` and ${gap.more} more` : ''}.`
          : `Changed paths of member ${gap.submissionId} or of the shared State are unknown.`,
      },
    });
    await releaseLandingQueue(ctx, queue, now);
    await wakeBatch(ctx, key);
    return {
      status: 'pending' as const,
      reason: 'The shared State does not carry every member; exact single checks are queued.',
    };
  }
  // Resolve retained rejected merges before moving their now-matching base.
  // Clean survivors retain the same checked generation throughout.
  if (batch.included && batch.included.length < batch.members.length)
    await settleBatchConflicts(ctx, key, batch);
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
  const scoped = scopedRecheckPairs(run.gate) !== null;
  invariant(
    run.candidate.digest === candidateRow.digest && (run.gate?.mode === 'full' || scoped),
    'EVIDENCE_CHANGED',
    'The batch needs full-gate or scoped cohort recheck evidence for this exact Candidate.',
  );
  // A scoped cohort recheck is accepted on the solo recheck's terms (Issue 28f08555). Refused now
  // (main red, policy or trust changed), the cohort recomposes for one full shared check instead.
  if (scoped && (await hostedAcceptGate(ctx, project, candidate, attempt.actor, run)) !== 'pass') {
    await retryLandingBatch(ctx, key, batch);
    await releaseLandingQueue(ctx, queue, now);
    return {
      status: 'pending' as const,
      reason: 'The scoped cohort recheck is no longer accepted; the cohort is recomposing one full check.',
    };
  }
  const check = {
    ...attempt.check,
    terminalDigest: run.terminalDigest!,
    planDigest: run.planDigest!,
    executionId: run.executionId!,
    ...(run.macEvidence ? { macEvidence: run.macEvidence } : {}),
    ...(run.plan?.skipped ? { skipped: run.plan.skipped } : {}),
    ...(run.actions?.isolation ? { isolation: run.actions.isolation } : {}),
  };
  // Issue 93e14bb0: the shared run diffed the whole stacked change; main's (last) receipt carries it.
  const secretAllowAdded = secretAllowMark(run.plan?.secretAllow, candidate.governance?.paths ?? null);
  let previousSnapshot = main.snapshotId;
  const receipts = [];
  const completions: { identity: ReceiptIdentity; planId: Id<'projectHostedAcceptancePlans'> }[] = [];
  const messages = [];
  for (const member of members) messages.push(await acceptedLandingMessage(ctx, member.state));
  for (const [index, member] of members.entries()) {
    const message = messages[index];
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
      ...(message === undefined ? {} : { message }),
      // The last receipt is main's receipt and the one the GitHub mirror commits
      // (enqueueGithubMirror below): it carries every member's message, or the
      // commit loses peers' prose and trailers (batch 9f919ded, Issue eacfdb6e).
      ...(index === members.length - 1
        ? {
            cohortMessages: messages.filter((m): m is string => m !== undefined),
          }
        : {}),
      batchId: batch.id,
      ...firstCheckField(
        firstCheckReceipt(member.row.admission, {
          runId: check.runId,
          reused: false,
          batch: true,
          scoped: run.plan?.scoped,
        }),
      ),
      ...orderWaitsField(member.row.orderWaits),
      actor: member.attempt.actor,
      ...(member.row.agentRun ? { agentRun: member.row.agentRun } : {}),
      policyDigest: member.attempt.policyDigest,
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
        ...landingCompletion(policy.lifecycle, member.state.request),
      },
      automatic: true,
      ...(secretAllowAdded && index === members.length - 1 ? { secretAllowAdded } : {}),
      undo: { kind: 'revert', receiptId: member.attempt.operations.accept },
      // The shared State's docs merges (Issue 561996ac), like secretAllowAdded on the last receipt.
      ...(candidate.docs && index === members.length - 1
        ? {
            docsResolution: {
              ...candidate.docs,
              undo: landingDocsUndo(member.attempt.operations.accept),
            },
          }
        : {}),
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
      acceptance: {
        receiptId: receipt.id,
        head,
        ...(receipt.docsResolution ? { docsResolution: receipt.docsResolution } : {}),
        acceptedBy: landingAcceptedBy({ actor: receipt.actor, at: receipt.at }),
      },
      observation: landingObservation('accepted'),
      error: null,
    };
    // Earlier members can transfer order waiters to this member within this
    // transaction. Re-read that row so its new orderWaited flag is consumed;
    // using the preloaded row strands passing successor groups without a wake.
    const currentRow = await landingRow(ctx, { projectId: claim.projectId, submissionId: member.state.id });
    invariant(currentRow, 'SOURCE_UNAVAILABLE', 'The batch member disappeared.');
    await writeLanding(ctx, currentRow, next, false);
    await settleLandingOperation(ctx, next);
    if (member.plan.inputPages) completions.push({ identity, planId: member.plan._id });
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
  const precompose = {
    receiptIds: receipts.map(receipt => receipt.id),
  };
  for (const [index, { identity, planId }] of completions.entries())
    await scheduleAcceptanceCompletion(ctx, planId, { ...identity, ...(index === 0 ? { precompose } : {}) });
  if (!completions.length)
    await scheduleLandingPrecompose(ctx, {
      projectId: claim.projectId,
      ...precompose,
      candidate: { id: last.candidate.id, actor: last.actor.id, digest: last.candidate.digest },
    });
  await endLandedApprovals(ctx, granted);
  await writeBatch(ctx, key, { ...batch, phase: 'landed' });
  await releaseLandingQueue(ctx, queue, now);
  await noteMainLanding(ctx, { project, receipt: last, run });
  await enqueueGithubMirror(ctx, project, last);
  await alertSecretAllowAdded(ctx, project, last);
  return { status: 'landed' as const, receipt: receipts.find(r => r.submissionId === state.id)! };
}
