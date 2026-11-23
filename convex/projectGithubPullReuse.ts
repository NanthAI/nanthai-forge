// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ZodError } from 'zod';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { parseInbound, twoWay } from './projectGithubInboundQueue';
import { checkSetting, loadHostedCheck } from './projectHostedCheckStore';
import { auditRow, mainGate } from './projectHostedMainAuditState';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { checkCause, checkPin } from '../src/hosted-check';
import { hostedVerdictKey } from '../src/hosted-check-evidence';
import { checkRunEntryPaths } from '../src/first-check-risk';
import { fullGate, docsGate } from '../src/main-audit';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { CrossHeadProof } from '../src/hosted-cross-head-proof';
import type { HostedMainV2 } from '../src/hosted-main';
import type { GithubSyncCommit } from '../src/github-sync-types';
import { effectivePolicy } from '../src/autonomy-policy';
import { ForgeError } from '../src/errors';
import { isPullOperation } from '../src/github-pull-check';
import { hasWriteRole } from './projectRole';

type Basis = Pick<
  CrossHeadProof,
  'checked' | 'checkedBase' | 'main' | 'head' | 'runId' | 'terminalDigest' | 'planDigest' | 'audit'
>;
export type PullReuseProbe = {
  number: number;
  head: string;
  repositoryId: number;
  trigger: string;
  basis: Basis;
  selection: string;
  checkEntries: string[];
};
export type GithubInboundProof = {
  proof: Extract<CrossHeadProof, { algorithm: 'exact-tree-v1' }>;
  trigger: string;
  repository: string;
};

/** Select retained Forge evidence before spending the optional GitHub lookup. A tree match is
 * only an index key; the action still has to prove the merge and the full native file tree. */
export async function pullReuseProbe(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  job: Doc<'projectGithubMirrorJobs'>,
  mapping: GithubSyncCommit,
  receipt: HostedAcceptance,
  main: HostedMainV2,
  input: { tree: string; head: { sha256: string } },
): Promise<{ reason: string } | { probe: PullReuseProbe }> {
  const no = (reason: string) => ({ reason });
  const policy = effectivePolicy(project).acceptance;
  if (!twoWay(project) || policy.hostedCrossHeadReuse === false || policy.mode !== 'auto-on-pass')
    return no('policy');
  if (receipt.id !== main.receipt.id || receipt.candidate.head !== main.head || mapping.state !== main.head)
    return no('main-moved');
  const [prior, ambiguous] = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_pull_tree', q => q.eq('projectId', project._id).eq('pullTree', input.tree))
    .order('desc')
    .take(2);
  if (!prior || ambiguous || !prior.inbound || !prior.pullKey) return no('no-unique-checked-tree');
  if (
    prior.repository.toLowerCase() !== job.repository.toLowerCase() ||
    prior.authorityEpoch !== job.authorityEpoch
  )
    return no('foreign-proof');
  let checked;
  try {
    checked = parseInbound(prior);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return no('missing-exact-evidence');
    throw error;
  }
  const pull = checked.pull;
  if (!pull || checked.tree !== input.tree || checked.commit !== pull.head)
    return no('no-unique-checked-tree');
  if (pull.fork) return no('fork');
  if (!prior.pullMember || !prior.pullRepositoryId) return no('unverified-member');
  if (!(await hasWriteRole(ctx, project, prior.pullMember))) return no('trigger-no-longer-writer');
  const [latest] = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_pull', q => q.eq('projectId', project._id).eq('pullKey', prior.pullKey))
    .order('desc')
    .take(1);
  if (latest?._id !== prior._id) return no('head-changed');
  if (pull.outcome !== 'success' || !pull.runId) return no('missing-run');
  if (checked.pullBaseCommit !== mapping.commit) return no('main-moved');
  const base = { head: main.head, receiptId: main.receipt.id };
  if (checked.base?.head !== base.head || checked.base.receiptId !== base.receiptId) return no('main-moved');
  const projectId = project._id;
  try {
    const { row, run } = await loadHostedCheck(ctx, { projectId, runId: pull.runId }, false);
    if (
      row.cause !== checkCause.pull ||
      !isPullOperation(run.request.operationId) ||
      run.request.origin === 'fork-pull' ||
      run.actor !== project.owner ||
      run.request.candidateId !== row.candidateId ||
      run.request.expectedHead !== prior.state ||
      run.candidate.base.head !== base.head ||
      run.candidate.base.receiptId !== base.receiptId ||
      run.request.authorityEpoch !== job.authorityEpoch ||
      run.configuration.provider !== 'github-actions' ||
      run.configuration.repository.toLowerCase() !== job.repository.toLowerCase() ||
      !run.dispatchStarted ||
      !run.executionId ||
      !/^[1-9]\d*$/.test(run.executionId) ||
      run.actions?.outcome !== 'accepted' ||
      run.actions.fence !== run.fence ||
      run.dispatchKey !== checkPin({ projectId, runId: run.id, operationId: run.request.operationId }) ||
      row.verdictKey !== hostedVerdictKey(run) ||
      !run.plan ||
      !run.planDigest ||
      !run.terminalDigest ||
      !fullGate(run) ||
      docsGate(run) ||
      run.semanticPlan
    )
      return no('missing-forge-dispatch');
    if (run.actions.workflowSha !== mapping.commit) return no('workflow-changed');
    if (Math.min(Date.parse(run.at), run.actions.reservedAt) < Date.parse(receipt.at))
      return no('run-predates-base');
    if (project.landingCheckId !== run.check.id) return no('check-changed');
    const definition = await checkSetting(ctx, projectId, 'definition', run.check.id);
    const runner = await checkSetting(ctx, projectId, 'runner', 'runner');
    if (definition?.digest !== run.request.expectedDefinition) return no('check-changed');
    if (
      runner?.digest !== run.request.expectedConfiguration ||
      run.configuration.environmentFingerprint !== run.request.expectedEnvironment
    )
      return no('runner-changed');
    await requireHostedCheckEvidence(
      ctx,
      {
        projectId,
        actor: project.owner,
        authorityEpoch: job.authorityEpoch,
        runId: run.id,
        candidateId: run.request.candidateId,
        head: run.request.expectedHead,
        checkId: run.check.id,
        definition: run.check.definition,
        configuration: run.request.expectedConfiguration,
        environment: run.request.expectedEnvironment,
      },
      run,
    );
    const saved = await auditRow(ctx, projectId);
    const gate = await mainGate(ctx, projectId, saved);
    const green = saved?.lastGreen;
    const receiptCheck =
      saved?.firstCheck === main.sourceRevision || receipt.crossHeadProof ? undefined : receipt.check;
    if (gate.debt || gate.status === 'red') return no('main-audit');
    const currentGreen = green?.sequence === main.sourceRevision && green.head === main.head ? green : null;
    const auditId = receiptCheck?.runId ?? currentGreen?.runId;
    if (!auditId) return no('main-audit');
    const audit = (await loadHostedCheck(ctx, { projectId, runId: auditId }, false)).run;
    if (
      !audit.plan ||
      !audit.planDigest ||
      !audit.terminalDigest ||
      !fullGate(audit) ||
      docsGate(audit) ||
      (receiptCheck &&
        (receipt.candidate.digest !== audit.candidate.digest ||
          receiptCheck.terminalDigest !== audit.terminalDigest ||
          receiptCheck.planDigest !== audit.planDigest))
    )
      return no('main-audit');
    await requireHostedCheckEvidence(
      ctx,
      {
        projectId,
        actor: project.owner,
        authorityEpoch: job.authorityEpoch,
        runId: audit.id,
        candidateId: audit.request.candidateId,
        head: main.head,
        checkId: run.check.id,
        definition: run.check.definition,
        configuration: run.request.expectedConfiguration,
        environment: run.request.expectedEnvironment,
      },
      audit,
    );
    return {
      probe: {
        number: pull.number,
        head: pull.head,
        repositoryId: prior.pullRepositoryId,
        trigger: prior.pullMember,
        selection: run.plan.selection.sha256,
        checkEntries: checkRunEntryPaths(run.check),
        basis: {
          checked: {
            id: run.request.candidateId,
            head: run.request.expectedHead,
            digest: run.candidate.digest,
          },
          checkedBase: base,
          main: base,
          head: input.head.sha256,
          runId: run.id,
          planDigest: run.planDigest,
          terminalDigest: run.terminalDigest,
          audit: {
            source: receiptCheck ? 'main-receipt' : 'audit',
            sequence: main.sourceRevision,
            head: main.head,
            runId: audit.id,
            terminalDigest: audit.terminalDigest,
            planDigest: audit.planDigest,
            selection: audit.plan.selection.sha256,
            coverage: 'main-audit-debt',
          },
        },
      },
    };
  } catch (error) {
    if (error instanceof ForgeError || error instanceof ZodError || error instanceof SyntaxError)
      return no('missing-exact-evidence');
    throw error;
  }
}
