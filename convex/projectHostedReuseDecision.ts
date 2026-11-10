// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './server';
import { loadFinish } from './projectHostedFinishStore';
import { loadLanding, loadLandingAttempt, type LandingIdentity } from './projectHostedLandingStore';
import { loadCompose } from './projectHostedComposeStore';
import { hostedWriteProject } from './projectHostedRecords';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { mainGate, auditRow, auditFreshness, VERIFIED_MAIN } from './projectHostedMainAuditState';
import { fastEffective } from '../src/landing-mode';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import { effectivePolicy } from '../src/autonomy-policy';
import { ForgeError } from '../src/errors';
import { fullGate, docsGate } from '../src/main-audit';
import { checkRunEntryPaths } from '../src/first-check-risk';
import { reducedEvidenceActor } from '../src/contract-gate-policy';
import { trustGateReader } from './projectHostedTrust';
import type { HostedCheckRun } from '../src/hosted-check';
/** Why the first check cannot carry this landing before any analysis (receipt field). */
export type ReuseIneligible =
  | 'not-eligible'
  | 'reuse-policy'
  | 'main-red'
  | 'audit-debt'
  | 'text-conflict'
  | 'check-evidence'
  | 'audit-baseline';
const bestTrust = { level: 'autonomous', reason: 'upper bound' } as const;
const no = (reason: ReuseIneligible) => ({ reason }) as const;
/** Transaction-local canonical reads; never part of the reuse action response. */
export type ReuseReads = {
  finish: Awaited<ReturnType<typeof loadFinish>>;
  landing: Awaited<ReturnType<typeof loadLanding>>;
  source?: Awaited<ReturnType<typeof loadCompose>>;
  checkedRun?: HostedCheckRun;
};
export async function reuseDecision(ctx: QueryCtx | MutationCtx, input: LandingIdentity, reads?: ReuseReads) {
  const { value } = reads?.finish ?? (await loadFinish(ctx, input));
  const { row: landing, state } = reads?.landing ?? (await loadLanding(ctx, input));
  // A batch publishes multiple same-head snapshots. The existing audit culprit
  // range does not prove a single-member reverse across those snapshots; retain
  // its one shared exact recheck rather than inventing recovery evidence.
  if (
    !value.pending ||
    state.phase !== 'ready' ||
    (state.batchId && !state.batchSolo) ||
    value.recoveryRunId ||
    value.restoreBases ||
    state.request.revertOf
  )
    return no('not-eligible');
  const previous = await loadLandingAttempt(ctx, {
    projectId: input.projectId,
    attemptId: value.pending.parentAttemptId,
  });
  const project = await hostedWriteProject(ctx, input.projectId, previous.actor.id, previous.authorityEpoch);
  const policy = effectivePolicy(project);
  // The project's policy keeps the exact recheck (a choice, not a Forge limitation).
  if (
    policy.acceptance.hostedCrossHeadReuse === false ||
    policy.acceptance.mode !== 'auto-on-pass' ||
    // Cheap bound before any other read: false even under the most generous trust.
    !reducedEvidenceActor(policy, project, previous.actor, policy.trust?.enabled ? bestTrust : null)
  )
    return no('reuse-policy');
  if (!previous.check || !previous.candidate.head || previous.semanticPlan?.members.length)
    return no('not-eligible');
  const checked = previous.crossHeadProof?.checked ?? {
    id: previous.candidate.id,
    head: previous.candidate.head,
    digest: previous.candidate.digest,
  };
  const checkedBase = previous.crossHeadProof?.checkedBase ?? previous.main;
  const audit = await mainGate(ctx, input.projectId);
  if (audit.status === 'red') return no('main-red');
  if (audit.debt) return no('audit-debt');
  const source = await loadCompose(ctx, {
    projectId: input.projectId,
    actor: state.actor,
    operationId: value.pending.operations.compose,
  });
  if (reads) reads.source = source;
  const result = source.operation.terminal?.outcome;
  if (result?.status !== 'completed') return no('text-conflict');
  const candidate = hostedRecordSchema.options[3].parse(result.result);
  if (candidate.result.status !== 'clean' || candidate.semanticPlan?.members.length)
    return no('text-conflict');
  // Policy decides who may reuse a passed check, like the contract gate: the owner's agent by
  // default, listed agents, and other agents only once trust (one actor row, read only when
  // trust is on) raises them above supervised on the Candidate's paths. Untrusted actors
  // keep the exact recheck.
  const trust = policy.trust?.enabled
    ? await trustGateReader(ctx, project)(previous.actor.id, candidate.governance?.paths ?? null)
    : null;
  if (!reducedEvidenceActor(policy, project, previous.actor, trust)) return no('reuse-policy');
  let run;
  try {
    run = await requireHostedCheckEvidence(ctx, {
      projectId: input.projectId,
      actor: previous.actor.id,
      candidateId: checked.id,
      head: checked.head,
      authorityEpoch: previous.authorityEpoch,
      ...previous.check,
    });
  } catch (error) {
    if (error instanceof ForgeError) return no('check-evidence');
    throw error;
  }
  // Any configured check command, on any runner: the proof reads paths, manifests
  // and the run's selection only, and the files the command names are global-risk.
  if (!run.plan || !run.terminalDigest || !run.planDigest) return no('check-evidence');
  if (reads) reads.checkedRun = run;
  const savedAudit = await auditRow(ctx, input.projectId);
  const parent = await acceptanceRow(ctx, {
    projectId: input.projectId,
    receiptId: value.pending.main.receiptId,
  });
  const receipt = parent ? hostedAcceptanceSchema.parse(JSON.parse(parent.value)) : null;
  const currentRun =
    receipt?.check && !receipt.crossHeadProof
      ? (await loadHostedCheck(ctx, { projectId: input.projectId, runId: receipt.check.runId })).run
      : null;
  // A newer exact full main pass supersedes older audit debt, including legacy
  // full gates that predate audit bookkeeping. Reduced main receipts use the
  // existing full audit baseline and retain all intervening debt.
  const preferReceipt = currentRun && fullGate(currentRun) && !docsGate(currentRun);
  const green = preferReceipt ? undefined : savedAudit?.lastGreen;
  const sourceKind = green ? ('audit' as const) : ('main-receipt' as const);
  const auditId = green?.runId ?? (!receipt?.crossHeadProof ? receipt?.check?.runId : null);
  if (!auditId) return no('audit-baseline');
  const auditRun =
    preferReceipt || currentRun?.id === auditId
      ? currentRun
      : (await loadHostedCheck(ctx, { projectId: input.projectId, runId: auditId })).run;
  if (
    !auditRun.plan ||
    !auditRun.planDigest ||
    !auditRun.terminalDigest ||
    auditRun.status !== 'passed' ||
    auditRun.check.definition !== run.check.definition ||
    auditRun.request.expectedConfiguration !== run.request.expectedConfiguration ||
    auditRun.request.expectedEnvironment !== run.request.expectedEnvironment ||
    auditRun.request.expectedHead !== (green?.head ?? value.pending.main.head)
  )
    return no('audit-baseline');
  if (
    !green &&
    (!receipt ||
      receipt.candidate.head !== value.pending.main.head ||
      receipt.candidate.digest !== auditRun.candidate.digest ||
      receipt.check?.terminalDigest !== auditRun.terminalDigest ||
      receipt.check.planDigest !== auditRun.planDigest)
  )
    return no('audit-baseline');
  try {
    await requireHostedCheckEvidence(
      ctx,
      {
        projectId: input.projectId,
        actor: previous.actor.id,
        candidateId: auditRun.request.candidateId,
        head: auditRun.request.expectedHead,
        authorityEpoch: previous.authorityEpoch,
        runId: auditRun.id,
        checkId: run.check.id,
        definition: run.check.definition,
        configuration: run.request.expectedConfiguration,
        environment: run.request.expectedEnvironment,
      },
      auditRun,
    );
  } catch (error) {
    if (error instanceof ForgeError) return no('audit-baseline');
    throw error;
  }
  const auditProof = {
    source: sourceKind,
    head: auditRun.request.expectedHead,
    runId: auditRun.id,
    terminalDigest: auditRun.terminalDigest,
    planDigest: auditRun.planDigest,
    selection: auditRun.plan.selection.sha256,
    sequence: green?.sequence ?? receipt!.snapshot.revision,
    coverage: 'main-audit-debt' as const,
  };
  return {
    actor: previous.actor.id,
    pendingId: value.pending.id,
    selection: run.plan.selection.sha256,
    ...(state.batchNeedsSoloCompose &&
    !state.batchOriginId &&
    landing.pipelineRetiredAttemptId === state.attemptId
      ? { exactTreeOnly: true }
      : {}),
    // The project's own check and setup-action entry files are global-risk (any runner).
    checkEntries: checkRunEntryPaths(run.check),
    // Fast landing mode: the policy asks for it, the project has earned it, the audit is fresh.
    fast: fastEffective(
      policy.acceptance.landingMode,
      savedAudit?.earned,
      sourceKind === 'main-receipt' ? VERIFIED_MAIN : auditFreshness(savedAudit, audit),
    ),
    basis: {
      checked,
      checkedBase,
      main: value.pending.main,
      head: candidate.result.head,
      runId: run.id,
      terminalDigest: run.terminalDigest,
      planDigest: run.planDigest,
      audit: auditProof,
    },
  };
}
