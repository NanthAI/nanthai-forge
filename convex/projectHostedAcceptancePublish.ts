// SPDX-License-Identifier: Apache-2.0
import { scheduleLandingPrecompose } from './projectHostedLandingPrecompose';
import { trackHostedOverlapMain } from './projectHostedOverlapStore';
import { hostedAcceptGate, holdMainRed } from './projectHostedGate';
import { protectedGatePaths, protectedPathMatches, reducedEvidenceActor } from '../src/contract-gate-policy';
import { noteMainLanding, mainGate, fastLanding } from './projectHostedMainAuditState';
import { noteTrustLanding, trustGateReader } from './projectHostedTrust';
import type { HostedCheckRun } from '../src/hosted-check';
import { enqueueGithubMirror } from './projectGithubMirrorQueue';
import type { MutationCtx } from './_generated/server';
import { activeProject } from './projectAuthority';
import { requireLandingLease, type LandingClaim } from './projectHostedLandingControl';
import { writeLanding, settleLandingOperation, loadLanding } from './projectHostedLandingStore';
import { releaseLandingQueue } from './projectHostedLandingWake';
import { acceptanceSelection, acceptanceRow, acceptancePlan } from './projectHostedAcceptanceStore';
import { channelRow } from './projectHostedChannels';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { saveObject } from './projectHostedSaveStore';
import { scheduleAcceptanceCompletion } from './projectHostedAcceptanceCompletion';
import { hostedMainV2Schema } from '../src/hosted-main';
import {
  hostedAcceptanceSchema,
  firstCheckField,
  orderWaitsField,
  firstCheckReceipt,
  landingCompletion,
} from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy, type AcceptanceActor } from '../src/autonomy-policy';
import { landingObservation } from '../src/hosted-landing';
import { policyDigestCurrent } from '../src/policy-digest';
import { scheduleWouldConflict } from './projectHostedLandingWouldConflict';
import { governanceReason, requiresGovernedCheck } from '../src/public-governance';
import { landingDocsUndo } from '../src/docs-resolution';
import { invariant } from '../src/errors';
import { validCrossHeadProof, fastProof } from '../src/hosted-cross-head-proof';
import { requireReuseAudit } from './projectHostedReuseAudit';
import { acceptedLandingMessage } from './projectHostedLandingMessage';
import { alertSecretAllowAdded } from './projectHostedSecretAllow';
import { secretAllowMark, secretAllowReview } from '../src/secret-allow';
import { grantedApproval } from './projectHostedOwnerGrant';
import { approvalHoldReason, attemptApprovals, endLandedApprovals } from './projectHostedApprovalStore';
import { landingAcceptedBy } from '../src/landing-accepted-by';
/** One constant-size publication transaction. A completed replay authorizes the
 * reader first, then returns the original receipt without rechecking old policy,
 * acquiring another lease or rewinding any later main/saved Lane. */
export async function publishAcceptance(
  ctx: MutationCtx,
  claim: LandingClaim,
  now = Date.now(),
  ownerApproval?: AcceptanceActor,
) {
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
  if (state.request.finish?.after) {
    const parent = await loadLanding(ctx, {
      projectId: claim.projectId,
      submissionId: state.request.finish.after,
    });
    invariant(
      parent.state.phase === 'landed',
      'LANDING_DEPENDENCY_PENDING',
      'The pinned parent submission has not landed.',
    );
  }
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
  invariant(
    !ownerApproval || (ownerApproval.id === project.owner && ownerApproval.kind === 'person'),
    'PROJECT_UNAVAILABLE',
    'Only explicit owner acceptance can approve protected paths.',
  );
  const policy = effectivePolicy(project);
  invariant(
    policyDigestCurrent(policy, attempt.policyDigest),
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
  // An owner approval retained for this submission (fe5bea80) carries only to exactly this source.
  const granted =
    ownerApproval || candidate.kind !== 'candidate'
      ? undefined
      : grantedApproval(row.ownerGrant, attempt, project.owner, candidate.governance?.paths ?? null);
  const actor = ownerApproval ?? granted ?? attempt.actor;
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
  const reuse = attempt.crossHeadProof;
  if (reuse) {
    // The same policy decision as the reuse proof: owner agent, listed agent, or trusted agent.
    const trust =
      policy.trust?.enabled && attempt.actor.id !== project.owner
        ? await trustGateReader(ctx, project)(attempt.actor.id, candidate.governance?.paths ?? null)
        : null;
    invariant(
      policy.acceptance.hostedCrossHeadReuse !== false &&
        policy.acceptance.mode === 'auto-on-pass' &&
        reducedEvidenceActor(policy, project, attempt.actor, trust) &&
        validCrossHeadProof(reuse) &&
        reuse.head === head &&
        reuse.main.head === main.head &&
        reuse.main.receiptId === main.receipt.id &&
        attempt.check?.runId === reuse.runId,
      'EVIDENCE_CHANGED',
      'The current acceptance does not match the cross-head proof.',
    );
    const audit = await mainGate(ctx, claim.projectId);
    invariant(
      !audit.debt && audit.status !== 'red',
      'CHECK_EVIDENCE_REFRESH',
      'Main audit changed; prepare fresh evidence.',
    );
    // A fast-mode proof is published only while the circuit breaker permits fast mode and the audit is
    // fresh, checked here again in the publication transaction (81d12a32, review note N2).
    invariant(
      !fastProof(reuse) || (await fastLanding(ctx, project, audit, reuse.audit.source === 'main-receipt')),
      'CHECK_EVIDENCE_REFRESH',
      'Fast landing is not in effect now; prepare fresh evidence.',
    );
    await requireReuseAudit(ctx, {
      projectId: claim.projectId,
      actor: attempt.actor.id,
      authorityEpoch: attempt.authorityEpoch,
      proof: reuse,
      main,
      check: attempt.check!,
    });
  }
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
  let run: HostedCheckRun | null = null;
  let check = null;
  if (attempt.check) {
    run = await requireHostedCheckEvidence(ctx, {
      projectId: claim.projectId,
      actor: attempt.actor.id,
      candidateId: reuse?.checked.id ?? candidate.id,
      head: reuse?.checked.head ?? head,
      authorityEpoch: attempt.authorityEpoch,
      ...attempt.check,
    });
    invariant(
      run.candidate.digest === (reuse?.checked.digest ?? candidateRow.digest) &&
        (!reuse ||
          (run.terminalDigest === reuse.terminalDigest &&
            run.planDigest === reuse.planDigest &&
            run.plan?.selection.sha256 === reuse.checkedSelection)),
      'EVIDENCE_CHANGED',
      'The exact run selected another Candidate record.',
    );
    check = {
      ...attempt.check,
      terminalDigest: run.terminalDigest!,
      planDigest: run.planDigest!,
      executionId: run.executionId!,
      ...(run.macEvidence ? { macEvidence: run.macEvidence } : {}),
      ...(run.plan?.skipped ? { skipped: run.plan.skipped } : {}),
      ...(run.actions?.isolation ? { isolation: run.actions.isolation } : {}),
    };
  }
  invariant(
    !(
      requiresGovernedCheck(project, actor) ||
      (policy.acceptance.gate === 'contract' && attempt.actor.id !== project.owner)
    ) || check,
    'CHECK_NOT_PASSED',
    'Agent acceptance requires an exact passing check.',
  );
  // Entry files of every defined check and setup action are protected by default: the project
  // row's list plus the run's own check (covers a project whose list is not yet filled).
  const checks = [...(run?.check ? [run.check] : []), ...(project.checkEntries ?? [])];
  const ownerReview =
    actor.kind === 'person' &&
    actor.id === project.owner &&
    attempt.actor.id === project.owner &&
    policy.acceptance.mode === 'auto-on-pass' &&
    policy.acceptance.gate === 'contract' &&
    !protectedGatePaths(policy, candidate.governance?.paths ?? null, checks);
  const gate =
    run && !ownerReview && !reuse
      ? await hostedAcceptGate(ctx, project, candidate, attempt.actor, run)
      : 'pass';
  if (gate === 'main-red') {
    const reason = 'Main audit is red; contract acceptance resumes when main is green.';
    const next = {
      ...state,
      version: state.version + 1,
      observation: landingObservation('queued'),
      error: { code: 'MAIN_RED', message: reason },
    };
    await holdMainRed(ctx, row, next);
    await releaseLandingQueue(ctx, queue, now);
    return { status: 'pending' as const, reason, request: next };
  }
  invariant(gate === 'pass', 'CHECK_NOT_PASSED', 'This Candidate requires an exact full check.');
  const protectedReason =
    policy.acceptance.gate === 'contract' &&
    !(actor.kind === 'person' && actor.id === project.owner) &&
    // Issue 470ef29b: owner-only inputs never excuse an agent, the owner's own included.
    protectedGatePaths(policy, candidate.governance?.paths ?? null, checks)
      ? 'needs owner approval: protected or unknown paths'
      : null;
  // Issue 93e14bb0: from the run plan and changed paths already loaded; no extra read.
  const secretAllowAdded = secretAllowMark(run?.plan?.secretAllow, candidate.governance?.paths ?? null);
  // Issue fe5bea80: a builder's approval request on a landed Lane holds it until the owner grants
  // that exact Lane head (or accepts the held landing as a person). One read, normally empty.
  const approvals = await attemptApprovals(ctx, claim.projectId, attempt.operations.accept);
  const approvalReason =
    actor.kind === 'person' && actor.id === project.owner ? null : approvalHoldReason(approvals);
  const reason =
    [
      governanceReason(project, policy, actor, candidate.governance?.paths ?? null, checks) ??
        protectedReason ??
        secretAllowReview(policy, actor, secretAllowAdded),
      approvalReason,
    ]
      .filter(Boolean)
      .join('; ') || null;
  if (reason) {
    const next = {
      ...state,
      version: state.version + 1,
      observation: landingObservation('waiting-for-review'),
      error: { code: 'REVIEW_REQUIRED', message: reason },
    };
    await writeLanding(ctx, row, next, false);
    await releaseLandingQueue(ctx, queue, now);
    return { status: 'pending' as const, reason, request: next };
  }
  const message = await acceptedLandingMessage(ctx, state);
  // Who accepted it, from facts already loaded (fe5bea80): `actor` names the submitter only.
  const grant = granted ? row.ownerGrant : undefined;
  const acceptedBy = landingAcceptedBy({
    actor,
    at: new Date(now).toISOString(),
    acceptedAt: grant?.at ?? now,
    head: grant ? (grant.head ?? (grant.attemptId === attempt.id ? head : undefined)) : head,
    protectedPaths:
      actor.kind === 'person'
        ? protectedPathMatches(policy, candidate.governance?.paths ?? null, checks)
        : undefined,
    carried: grant ? grant.attemptId !== attempt.id : false,
  });
  const receipt = hostedAcceptanceSchema.parse({
    schema: 1,
    id: identity.receiptId,
    projectId: claim.projectId,
    channel: claim.channel,
    submissionId: state.id,
    operationId: state.operationId,
    attemptId: attempt.id,
    ...(message === undefined ? {} : { message }),
    at: new Date(now).toISOString(),
    authorityEpoch: attempt.authorityEpoch,
    previous: attempt.main,
    candidate: attempt.candidate,
    ...orderWaitsField(row.orderWaits),
    actor,
    ...(row.agentRun ? { agentRun: row.agentRun } : {}),
    ...(row.agentClient ? { agentClient: row.agentClient } : {}),
    policyDigest: attempt.policyDigest,
    check,
    ...(reuse ? { crossHeadProof: reuse } : {}),
    ...firstCheckField(
      firstCheckReceipt(row.admission, {
        runId: attempt.check?.runId,
        reused: Boolean(reuse),
        batch: false,
        ...(reuse ? { rule: reuse.algorithm } : {}),
        scoped: reuse ? undefined : run?.plan?.scoped,
      }),
    ),
    snapshot: { id: identity.receiptId, previousId: main.snapshotId, revision: main.sourceRevision + 1 },
    completion: {
      root: plan.root,
      pages: plan.inputPages,
      lanes: plan.lanes,
      ...landingCompletion(policy.lifecycle, state.request),
    },
    automatic: requiresGovernedCheck(project, actor),
    ...(secretAllowAdded ? { secretAllowAdded } : {}),
    undo: { kind: 'revert', receiptId: identity.receiptId },
    ...(candidate.docs
      ? { docsResolution: { ...candidate.docs, undo: landingDocsUndo(identity.receiptId) } }
      : {}),
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
  await trackHostedOverlapMain(
    ctx,
    claim.projectId,
    receipt.snapshot.revision,
    candidate.governance?.paths ?? null,
  );
  await scheduleWouldConflict(ctx, {
    projectId: claim.projectId,
    paths: candidate.governance?.paths ?? null,
    landedSubmissionId: state.id,
  });
  const next = {
    ...state,
    version: state.version + 1,
    phase: 'landed' as const,
    acceptance: {
      receiptId: receipt.id,
      head,
      ...(run?.proofOnLanding ? { proofRunId: run!.id } : {}),
      ...(receipt.docsResolution ? { docsResolution: receipt.docsResolution } : {}),
      acceptedBy,
    },
    observation: landingObservation('accepted'),
    error: null,
  };
  // Exact evidence above already proved this run terminal. A different retained run still releases.
  await writeLanding(ctx, row, next, false, row.runId !== run?.id);
  await endLandedApprovals(ctx, approvals);
  await settleLandingOperation(ctx, next);
  await releaseLandingQueue(ctx, queue, now);
  await noteMainLanding(ctx, { project, receipt, run });
  await noteTrustLanding(ctx, {
    project,
    actor: attempt.actor.id,
    receiptId: receipt.id,
    at: receipt.at,
    paths: candidate.governance?.paths ?? null,
    run,
  });
  await enqueueGithubMirror(ctx, project, receipt);
  await alertSecretAllowAdded(ctx, project, receipt);
  // The completion tick also retires landed work from overlap, so it runs even when keepOpen or policy skips completion.
  const precompose = { receiptIds: [receipt.id] };
  if (plan.inputPages) await scheduleAcceptanceCompletion(ctx, plan._id, { ...identity, precompose });
  else
    await scheduleLandingPrecompose(ctx, {
      projectId: claim.projectId,
      ...precompose,
      candidate: { id: receipt.candidate.id, actor: receipt.actor.id, digest: receipt.candidate.digest },
    });
  // Numeric only: shared operator log streams must contain no receipt or user data.
  if (state.request.closes !== false) console.log('FORGE_ACCEPTED_LANDINGS 1');
  return { status: 'landed' as const, receipt };
}
