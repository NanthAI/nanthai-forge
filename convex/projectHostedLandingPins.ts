// SPDX-License-Identifier: Apache-2.0
import { heldCommand } from './projectHostedLandingEnvironmentHold';
import { ciDownMessage } from './projectHostedLandingCiDown';
import { checkCause, submittedCheckCause, type CheckCause } from '../src/hosted-check';
import { refreshCheckEntries, requireLandingCheck } from './projectHostedCheckEntries';
import { earlyPredecessor } from './projectHostedEarlyResolution';
import { candidateOwnerInputs } from './projectHostedProvenance';
import { fixGate } from '../src/culprit-bisect';
import { batchEligible } from '../src/hosted-landing-batch';
import { semanticMember, mergeSemanticMembers } from './projectSemanticContracts';
import type { SemanticPlan } from '../src/intent-semantic-conflict';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireMemberAuthority } from './projectLaneAuthority';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { hostedStartMain } from './projectHostedChannels';
import { enqueueHostedCheck } from './projectHostedChecks';
import { loadHostedCheck } from './projectHostedCheckStore';
import { saveObject } from './projectHostedSaveStore';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  hostedLandingAttemptSchema,
  type HostedLandingRequest,
  type HostedLandingAttempt,
} from '../src/hosted-landing';
import { effectivePolicy, type AcceptanceActor } from '../src/autonomy-policy';
import { canonicalPayload } from '../src/hosted-source-operation';
import { acceptancePolicyDigest } from '../src/policy-digest';
import { ForgeError, invariant } from '../src/errors';
import type { ScopedRecheckBasis } from '../src/scoped-recheck-policy';
import { validCrossHeadProof, type CrossHeadProof } from '../src/hosted-cross-head-proof';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { hostedAcceptGate } from './projectHostedGate';
import type { GithubInboundProof } from './projectGithubPullReuse';
import { hasWriteRole } from './projectRole';
import { governanceReason, protectedPathMatches } from '../src/public-governance';
import { requireLandingPaths, type LandingGrant } from './accessPolicy';

type ExactTreeProof = Extract<CrossHeadProof, { algorithm: 'exact-tree-v1' }>;

/** Pin canonical metadata once. H14 still rechecks current main/policy/evidence
 * in its final transaction; neither this snapshot nor ready grants acceptance. */
export async function pinLandingAttempt(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: AcceptanceActor;
    request: HostedLandingRequest;
    submissionId: string;
    attemptId: string;
    parentAttemptId: string | null;
    number: number;
    at: string;
    operations: { check: string; accept: string };
    allowStaleMain?: boolean;
    deferCheck?: boolean;
    retainedSelection?: HostedLandingAttempt['candidate'];
    recheck?: ScopedRecheckBasis;
    githubProof?: GithubInboundProof;
    /** The landing row's folder grant stamp (df06081d). */
    grant?: LandingGrant | undefined;
    checkCause?: CheckCause;
    providerDelayReason?: string;
    auditDonor?: boolean;
    /** Reuses the initial submission's reservation lookup for cause attribution. */
    intent?: (intentId: string) => Promise<CheckCause>;
    paths?: (paths: string[] | null) => void;
    review?: (reason: string, verified: boolean) => void;
    reviewedPolicy?: string;
    /** Current main is already read for pin validation; source preparation may have raced it. */
    mainMoved?: (moved: boolean) => void;
    /** The queue row's CI-down hold, when the caller has the row in hand (submission). */
    heldCheck?: Doc<'projectHostedLandingQueues'>['ciDown'];
  },
) {
  invariant(
    input.parentAttemptId === null || input.actor.kind === 'agent' || input.retainedSelection !== undefined,
    'VIEW_STALE',
    'A person request retains the exact reviewed Candidate; a different selection uses a new request.',
  );
  const r = input.request;
  invariant(
    !r.revertOf || r.finish?.composeOperationId,
    'BAD_ARGUMENT',
    'A revert requires its retained reverse composition.',
  );
  const project = await hostedWriteProject(ctx, input.projectId, input.actor.id, r.authorityEpoch);
  const main = await hostedStartMain(ctx, input.projectId);
  input.mainMoved?.(main.head !== r.expectedMain.head || main.receipt.id !== r.expectedMain.receiptId);
  invariant(
    main.authority.epoch === r.authorityEpoch && main.authority.mode === project.sourceAuthority?.mode,
    'SOURCE_AUTHORITY_CHANGED',
    'Main and current project source authority differ.',
  );
  invariant(
    input.allowStaleMain ||
      input.retainedSelection !== undefined ||
      (input.actor.kind === 'person' && r.finish !== undefined) ||
      (main.head === r.expectedMain.head && main.receipt.id === r.expectedMain.receiptId),
    'CHANNEL_CHANGED',
    'Select the current main head and receipt.',
  );
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor.id,
    kind: 'candidate',
    key: r.candidateId,
  });
  invariant(row, 'NOT_FOUND', 'Select a canonical hosted Candidate.');
  // Submitting another member's Candidate is the owner's call only (Issue 8809fba5).
  if (row.creatorAccountId !== undefined)
    requireMemberAuthority(project, row.creatorAccountId, input.actor.id, 'Candidate');
  const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
  invariant(
    candidate.kind === 'candidate' &&
      (candidate.result.status === 'clean'
        ? candidate.result.head === r.expectedHead
        : r.expectedHead === null),
    'VIEW_STALE',
    'Select the original Candidate and its exact clean head or conflict.',
  );
  invariant(
    candidate.base.head === r.expectedMain.head && candidate.base.receiptId === r.expectedMain.receiptId,
    'CHANNEL_CHANGED',
    'The Candidate retains a different main base receipt.',
  );
  for (const early of candidate.earlyResolutions ?? [])
    await earlyPredecessor(ctx, input.projectId, early.predecessor);
  // A folder-grant landing whose own files are known stops here, before any check (df06081d); in memory.
  if (input.grant && candidate.governance) requireLandingPaths(input.grant.paths, candidate.governance.paths);
  input.paths?.(candidate.governance?.paths ?? null);
  if (input.retainedSelection) {
    invariant(
      canonicalPayload(candidate.inputs) === canonicalPayload(input.retainedSelection.inputs) &&
        canonicalPayload(candidate.dependencies) === canonicalPayload(input.retainedSelection.dependencies),
      'WORK_OPERATION_CHANGED',
      'A finish retry must retain the original ordered selection.',
    );
  }
  const recoveryGate = fixGate({ needsFix: row.restoreBases ?? project.needsFix?.[candidate.intentId] });
  const policy = effectivePolicy(project);
  const paths = candidate.governance?.paths ?? null;
  const canReview =
    input.review &&
    r.finish &&
    r.check &&
    candidate.result.status === 'clean' &&
    (input.actor.kind !== 'person' || input.actor.id !== project.owner);
  // Use the same one-time definition projection as check enqueue. Legacy rows
  // need its check-entry paths before choosing a potentially shared check.
  const checkEntries =
    canReview && paths?.length
      ? (project.checkEntries ?? (await refreshCheckEntries(ctx, input.projectId)))
      : project.checkEntries;
  const earlyReview =
    canReview && protectedPathMatches(policy, paths, checkEntries)?.length
      ? governanceReason(project, policy, input.actor, paths, checkEntries)
      : null;
  const verifiedReview = Boolean(
    earlyReview && input.reviewedPolicy && input.reviewedPolicy === acceptancePolicyDigest(policy),
  );
  if (earlyReview) input.review?.(earlyReview, verifiedReview);
  const deferredCheck =
    verifiedReview ||
    (!recoveryGate &&
      !earlyReview &&
      candidateOwnerInputs(project, row, candidate, r.authorityEpoch) &&
      input.deferCheck !== false &&
      // A folder-grant landing checks and lands alone, where its grant is rechecked (df06081d).
      !input.grant &&
      r.finish &&
      !r.finish.after &&
      !r.revertOf &&
      r.check?.kind === 'request' &&
      batchEligible(project, policy, input.actor, candidate));
  const cause =
    input.checkCause ?? (await input.intent?.(candidate.intentId)) ?? submittedCheckCause(r.retryReason);
  let check = null;
  let crossHeadProof: ExactTreeProof | undefined;
  let semanticPlan: SemanticPlan | undefined;
  if (candidate.result.status === 'clean') {
    const head = candidate.result.head;
    const registered = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', head))
      .unique();
    invariant(registered, 'SOURCE_UNAVAILABLE', 'The clean Candidate needs trusted source registration.');
    const source = await saveObject(ctx, input.projectId, { sha256: head });
    invariant(
      source.object.size === registered.size,
      'SOURCE_HASH_MISMATCH',
      'Registered source size differs.',
    );
    const proof = input.githubProof?.proof;
    if (
      proof &&
      policy.githubMirror?.inbound &&
      policy.githubMirror.autoPush &&
      policy.githubMirror.repo.toLowerCase() === input.githubProof!.repository.toLowerCase() &&
      r.check?.kind === 'request' &&
      !recoveryGate &&
      !deferredCheck &&
      !candidate.semanticPlan &&
      input.actor.id === project.owner &&
      policy.acceptance.mode === 'auto-on-pass' &&
      policy.acceptance.hostedCrossHeadReuse !== false &&
      proof.head === head &&
      proof.checkedBase.head === main.head &&
      proof.checkedBase.receiptId === main.receipt.id &&
      proof.main.head === main.head &&
      proof.main.receiptId === main.receipt.id &&
      r.expectedMain.head === main.head &&
      r.expectedMain.receiptId === main.receipt.id &&
      validCrossHeadProof(proof) &&
      (await hasWriteRole(ctx, project, input.githubProof!.trigger))
    ) {
      const pins = {
        runId: proof.runId,
        checkId: r.check.checkId,
        definition: r.check.expectedDefinition,
        configuration: r.check.expectedConfiguration,
        environment: r.check.expectedEnvironment,
      };
      try {
        const run = await requireHostedCheckEvidence(ctx, {
          ...pins,
          projectId: input.projectId,
          actor: input.actor.id,
          authorityEpoch: r.authorityEpoch,
          candidateId: proof.checked.id,
          head: proof.checked.head,
        });
        if (
          run.candidate.digest === proof.checked.digest &&
          run.terminalDigest === proof.terminalDigest &&
          run.planDigest === proof.planDigest &&
          run.plan?.selection.sha256 === proof.checkedSelection &&
          (await hostedAcceptGate(ctx, project, candidate, input.actor, run)) === 'pass'
        ) {
          check = pins;
          crossHeadProof = proof;
        }
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
      }
    }
    if (!check && r.check && !deferredCheck) {
      // Item 0d14c456: a check its environment fails every time is not dispatched again; the
      // submission is refused with the hold's cause and resume step (no run, nothing to undo).
      invariant(
        !heldCommand(input.heldCheck, r),
        'RUNNER_UNAVAILABLE',
        input.heldCheck ? ciDownMessage(input.heldCheck) : 'Check environment hold.',
      );
      const run =
        r.check.kind === 'run'
          ? (await loadHostedCheck(ctx, { projectId: input.projectId, runId: r.check.runId })).run
          : await enqueueHostedCheck(ctx, {
              cause,
              ...(input.auditDonor === undefined ? {} : { auditDonor: input.auditDonor }),
              usageSubmissions: [input.submissionId],
              projectId: input.projectId,
              actor: input.actor.id,
              ...(earlyReview ? { protectedReview: true } : {}),
              ...(input.recheck ? { recheck: input.recheck } : {}),
              ...(input.providerDelayReason ? { providerDelayReason: input.providerDelayReason } : {}),
              request: {
                ...(recoveryGate ? { gate: recoveryGate } : r.check.gate ? { gate: r.check.gate } : {}),
                operationId: input.operations.check,
                authorityEpoch: r.authorityEpoch,
                candidateId: r.candidateId,
                expectedHead: head,
                checkId: r.check.checkId,
                expectedDefinition: r.check.expectedDefinition,
                expectedConfiguration: r.check.expectedConfiguration,
                expectedEnvironment: r.check.expectedEnvironment,
              },
            });
      await hostedWriteProject(ctx, input.projectId, run.actor, r.authorityEpoch);
      invariant(
        run.request.candidateId === r.candidateId &&
          run.request.expectedHead === head &&
          run.request.authorityEpoch === r.authorityEpoch &&
          run.candidate.digest === row.digest,
        'EVIDENCE_CHANGED',
        'The selected check belongs to different source or authority pins.',
      );
      semanticPlan = run.semanticPlan;
      if (!semanticPlan && candidate.semanticPlan) {
        const member = await semanticMember(
          ctx,
          { projectId: input.projectId, actor: input.actor.id },
          candidate.intentId,
        );
        if (member)
          semanticPlan = {
            ...mergeSemanticMembers(candidate.intentId, candidate.semanticPlan.members, [member]),
            ...(candidate.semanticPlan.afterSequence !== undefined
              ? { afterSequence: candidate.semanticPlan.afterSequence }
              : {}),
          };
      }
      check = {
        runId: run.id,
        checkId: run.check.id,
        definition: run.check.definition,
        configuration: run.request.expectedConfiguration,
        environment: run.request.expectedEnvironment,
      };
    }
  }
  const selectedCheck = check?.checkId ?? (r.check?.kind === 'request' ? r.check.checkId : undefined);
  if (selectedCheck) await requireLandingCheck(ctx, project, input.actor, selectedCheck);
  const { parentAttemptId, number } = input;
  return hostedLandingAttemptSchema.parse({
    ...(semanticPlan ? { semanticPlan } : {}),
    ...(candidate.earlyResolutions?.length ? { earlyResolutions: candidate.earlyResolutions } : {}),
    ...(deferredCheck
      ? { deferredCheck: true, ...(cause !== checkCause.first ? { checkCause: cause } : {}) }
      : {}),
    ...(input.recheck ? { recheck: input.recheck } : {}),
    schema: 1,
    projectId: input.projectId,
    submissionId: input.submissionId,
    operationId: r.operationId,
    id: input.attemptId,
    parentAttemptId,
    number,
    at: input.at,
    actor: input.actor,
    authorityEpoch: r.authorityEpoch,
    main: r.expectedMain,
    candidate: {
      id: candidate.id,
      digest: row.digest,
      head: r.expectedHead,
      inputs: candidate.inputs,
      dependencies: candidate.dependencies,
      algorithm: candidate.algorithm,
    },
    check,
    ...(crossHeadProof ? { crossHeadProof } : {}),
    policy,
    policyDigest: acceptancePolicyDigest(policy),
    operations: input.operations,
  });
}
