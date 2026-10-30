// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import { loadFinish } from './projectHostedFinishStore';
import { loadLanding, loadLandingAttempt, type LandingIdentity } from './projectHostedLandingStore';
import { loadCompose } from './projectHostedComposeStore';
import { hostedWriteProject } from './projectHostedRecords';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { saveObject } from './projectHostedSaveStore';
import { mainGate } from './projectHostedMainAuditState';
import { auditRow } from './projectHostedMainAuditState';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { installFinishCompose } from './projectHostedFinishCompose';
import { hostedRecordSchema } from '../src/hosted-records';
import { effectivePolicy } from '../src/autonomy-policy';
import { crossHeadProofSchema } from '../src/hosted-cross-head-proof';
import { ForgeError, invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { fullGate, docsGate } from '../src/main-audit';
import { scheduleFinish } from './projectHostedFinishWake';
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
/** Constant-size admission; uncertainty keeps the existing exact recheck. */
export async function reuseContext(ctx: QueryCtx | MutationCtx, input: LandingIdentity) {
  const { value } = await loadFinish(ctx, input);
  const { state } = await loadLanding(ctx, input);
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
    return null;
  const previous = await loadLandingAttempt(ctx, {
    projectId: input.projectId,
    attemptId: value.pending.parentAttemptId,
  });
  const project = await hostedWriteProject(ctx, input.projectId, previous.actor.id, previous.authorityEpoch);
  const policy = effectivePolicy(project);
  if (
    policy.acceptance.hostedCrossHeadReuse === false ||
    policy.acceptance.mode !== 'auto-on-pass' ||
    previous.actor.kind !== 'agent' ||
    previous.actor.id !== project.owner ||
    !previous.check ||
    !previous.candidate.head ||
    previous.semanticPlan?.members.length
  )
    return null;
  const checked = previous.crossHeadProof?.checked ?? {
    id: previous.candidate.id,
    head: previous.candidate.head,
    digest: previous.candidate.digest,
  };
  const checkedBase = previous.crossHeadProof?.checkedBase ?? previous.main;
  const audit = await mainGate(ctx, input.projectId);
  if (audit.status === 'red' || audit.debt) return null;
  const source = await loadCompose(ctx, {
    projectId: input.projectId,
    actor: state.actor,
    operationId: value.pending.operations.compose,
  });
  const result = source.operation.terminal?.outcome;
  if (result?.status !== 'completed') return null;
  const candidate = hostedRecordSchema.options[3].parse(result.result);
  if (candidate.result.status !== 'clean' || candidate.semanticPlan?.members.length) return null;
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
    if (error instanceof ForgeError) return null;
    throw error;
  }
  if (
    !run.plan ||
    !run.terminalDigest ||
    !run.planDigest ||
    run.check.args.join('\0') !== 'scripts/forge-check.mjs' ||
    !/(?:^|\/)node$/.test(run.check.executable)
  )
    return null;
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
  if (!auditId) return null;
  const auditRun = preferReceipt
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
    return null;
  if (
    !green &&
    (!receipt ||
      receipt.candidate.head !== value.pending.main.head ||
      receipt.candidate.digest !== auditRun.candidate.digest ||
      receipt.check?.terminalDigest !== auditRun.terminalDigest ||
      receipt.check.planDigest !== auditRun.planDigest)
  )
    return null;
  try {
    await requireHostedCheckEvidence(ctx, {
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
    });
  } catch (error) {
    if (error instanceof ForgeError) return null;
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
export const context = internalQuery({ args: identity, returns: v.any(), handler: reuseContext });
const leased = { ...identity, pendingId: v.string(), owner: v.string() };
export const claim = internalMutation({
  args: leased,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const { row, value } = await loadFinish(ctx, input);
    const { state } = await loadLanding(ctx, input);
    if (state.phase !== 'ready' || value.pending?.id !== input.pendingId) return null;
    if (row.reuseLease?.pendingId === input.pendingId)
      return row.reuseLease.owner === input.owner && row.reuseLease.until > Date.now() ? input.owner : null;
    const owner = input.owner;
    const reuseLease = { pendingId: input.pendingId, owner, until: Date.now() + 60_000 };
    await ctx.db.patch(row._id, { reuseLease });
    await scheduleFinish(ctx, row, 60_000, true);
    return owner;
  },
});
export const renew = internalMutation({
  args: leased,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const { row, value } = await loadFinish(ctx, input);
    const { state } = await loadLanding(ctx, input);
    if (
      state.phase !== 'ready' ||
      value.pending?.id !== input.pendingId ||
      row.reuseLease?.owner !== input.owner ||
      row.reuseLease.pendingId !== input.pendingId ||
      row.reuseLease.until <= Date.now()
    )
      return false;
    await ctx.db.patch(row._id, { reuseLease: { ...row.reuseLease, until: Date.now() + 60_000 } });
    return true;
  },
});
export const objects = internalQuery({
  args: { ...identity, digests: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { state } = await loadLanding(ctx, input);
    await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
    return Promise.all(input.digests.map(sha256 => saveObject(ctx, input.projectId, { sha256 })));
  },
});
export const complete = internalMutation({
  args: { ...leased, proof: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { row, value } = await loadFinish(ctx, input);
    if (value.pending?.id !== input.pendingId) return null;
    if ((await loadLanding(ctx, input)).state.phase !== 'ready') return null;
    if (
      row.reuseLease?.owner !== input.owner ||
      row.reuseLease.pendingId !== input.pendingId ||
      row.reuseLease.until <= Date.now()
    )
      return null;
    const current = await reuseContext(ctx, input);
    const proof = input.proof && current ? crossHeadProofSchema.parse(JSON.parse(input.proof)) : undefined;
    if (proof && current)
      invariant(
        Object.entries(current.basis).every(
          ([key, value]) => canonicalPayload(proof[key as keyof typeof proof]) === canonicalPayload(value),
        ) && proof.checkedSelection === current.selection,
        'EVIDENCE_CHANGED',
        'Complete only the original current proof analysis.',
      );
    if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
    await ctx.db.patch(row._id, { wake: null });
    await installFinishCompose(ctx, row, value, proof || undefined);
    return null;
  },
});
