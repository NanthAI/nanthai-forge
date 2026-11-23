// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { cancelPendingTask } from './schedulerCancel';
import { fixGate } from '../src/culprit-bisect';
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { intentTestContext } from './projectIntentTestStore';
import { hostedWriteProject, writeHostedRecord } from './projectHostedRecords';
import { loadHostedCheck } from './projectHostedCheckStore';
import { parseTimingHistory } from '../src/hosted-test-timings';
import { intentTestContractSchema, latestTestContract } from '../src/intent-test-contract';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { mainGate } from './projectHostedMainAuditState';
import { trustGateReader } from './projectHostedTrust';
import { effectivePolicy, type AcceptanceActor } from '../src/autonomy-policy';
import { gateFor, gateForCandidates, acceptGate, type GateInput } from '../src/contract-gate-policy';
import type { HostedCheckRun } from '../src/hosted-check';
import { acceptScopedRecheck, isScopedRecheck, scopedRecheckPolicy } from '../src/scoped-recheck-policy';
import { GRAPH_FIRST_CONTRACT, acceptGraphFirst, isGraphFirstGate } from '../src/graph-first-check';
import type { HostedRecord } from '../src/hosted-records';
import { skippedReport } from '../src/intent-semantic-conflict';

/** Behaviour-neutral S0 placeholder; the owning slice supplies the implementation. */
export const noop = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async () => null,
});

type Candidate = Extract<HostedRecord, { kind: 'candidate' }>;
/** Reuse the caller's project, Candidate and (at enqueue) already-read Intent. */
export async function hostedGateInput(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  candidate: Candidate,
  actor: AcceptanceActor,
  member: GateInput['contract'],
  /** A main-race scoped recheck reads main's audit state under either gate. */
  options: { scopedRecheck?: boolean } = {},
): Promise<GateInput> {
  const policy = effectivePolicy(project);
  const enabled = policy.acceptance.gate === 'contract';
  const readMain = enabled || (options.scopedRecheck === true && scopedRecheckPolicy(policy.acceptance));
  const paths = candidate.governance?.paths ?? null;
  return {
    project,
    policy,
    actor,
    paths,
    ...(project.checkEntries ? { checks: project.checkEntries } : {}),
    ...(enabled && policy.trust?.enabled
      ? { trust: await trustGateReader(ctx, project)(actor.id, paths) }
      : {}),
    contract: enabled && !fixGate({ needsFix: project.needsFix?.[candidate.intentId] }) ? member : null,
    main: readMain
      ? await mainGate(ctx, project._id)
      : {
          status: 'unknown',
          unaudited: { count: 0, firstAt: null },
          debt: false,
          hold: null,
        },
  };
}
export { gateFor, gateForCandidates, acceptGate };
/** B2.5h seam: resolve the audit once for a list of already-read Candidates and
 * Intent contracts. No per-member Convex calls or record/history reads. Paths
 * must describe each member's change in the combined source. */
export async function hostedGateForCandidates(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  candidates: readonly { candidate: Candidate; actor: AcceptanceActor; contract: GateInput['contract'] }[],
) {
  const first = candidates[0];
  if (!first) return gateForCandidates([]);
  const shared = await hostedGateInput(ctx, project, first.candidate, first.actor, first.contract);
  const trustFor = trustGateReader(ctx, project);
  const trusts =
    shared.policy.acceptance.gate === 'contract' && shared.policy.trust?.enabled
      ? await Promise.all(
          candidates.map(({ candidate, actor }) => trustFor(actor.id, candidate.governance?.paths ?? null)),
        )
      : [];
  return gateForCandidates(
    candidates.map(({ candidate, actor, contract }, index) => ({
      ...shared,
      actor,
      paths: candidate.governance?.paths ?? null,
      ...(trusts.length ? { trust: trusts[index] } : {}),
      contract:
        shared.policy.acceptance.gate === 'contract' &&
        !fixGate({ needsFix: project.needsFix?.[candidate.intentId] })
          ? contract
          : null,
    })),
  );
}
/** Contract tests this run skipped (Item 687d1eda: a skip is not a pass). Contract evidence is those
 * tests alone, so one whose every test skipped leaves the gate with no evidence for it. Reads the
 * run's reports or, on R2-backed runs, the summary that keeps every gate test with its skip marker
 * (src/check-file-summary.ts). A missing report keeps its old reading: runners store only failing and
 * measured files. Zero reads. */
export function skippedContractTests(
  run: Pick<HostedCheckRun, 'gate' | 'contractReports' | 'reportSummary'>,
) {
  if (run.gate?.effective !== 'contract') return [];
  const reports = run.contractReports ?? run.reportSummary?.semantic;
  return (run.gate.tests ?? []).filter(test => skippedReport(reports?.[test]));
}
export async function hostedAcceptGate(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  candidate: Candidate,
  actor: AcceptanceActor,
  run: HostedCheckRun,
) {
  // Full and legacy evidence needs no contract/audit reads.
  if (!run.gate || run.gate.effective !== 'contract')
    return acceptGate(
      {
        project,
        actor,
        policy: effectivePolicy(project),
        paths: null,
        contract: null,
        main: { status: 'unknown', unaudited: { count: 0, firstAt: null }, debt: false, hold: null },
      },
      run.gate,
    );
  // A contract test that skipped is no evidence: the publication refusal names it.
  if (skippedContractTests(run).length) return 'full-required';
  // A scoped main-race recheck is accepted on the contract gate's terms.
  if (isScopedRecheck(run.gate))
    return acceptScopedRecheck(
      await hostedGateInput(ctx, project, candidate, actor, null, { scopedRecheck: true }),
    );
  // A package-graph first check too, without the Intent contract it does not have.
  if (isGraphFirstGate(run.gate))
    return acceptGraphFirst(await hostedGateInput(ctx, project, candidate, actor, GRAPH_FIRST_CONTRACT));
  // The authoritative run retains the contract selected at enqueue. Re-reading
  // today's Intent would add a record-head/body fan-in and replace that declaration.
  const contract =
    run.gate.contractVersion === undefined
      ? null
      : {
          version: run.gate.contractVersion,
          tests: (run.gate.tests ?? []).map(path => ({ path })),
        };
  return acceptGate(await hostedGateInput(ctx, project, candidate, actor, contract), run.gate);
}

/** One selected audit run supplies provenance; no run or Intent history scan. */
async function historyBasis(
  ctx: Parameters<typeof intentTestContext>[0],
  projectId: Doc<'hostedProjects'>['_id'],
) {
  const audit = await ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  const row = await ctx.db
    .query('projectHostedTestTimings')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  const history = parseTimingHistory(row?.history ?? '');
  if (!audit?.lastGreen || !history.runs.includes(audit.lastGreen.runId)) return null;
  const { run, row: runRow } = await loadHostedCheck(ctx, { projectId, runId: audit.lastGreen.runId });
  if (run.status !== 'passed' || run.request.expectedHead !== audit.lastGreen.head) return null;
  const timings = Object.fromEntries(
    Object.entries(history.files).flatMap(([path, value]) =>
      (
        runRow.reportStorage === 'r2'
          ? runRow.reportTimingComplete &&
            value.sourceRun === runRow.reportTimingStamp?.sequence &&
            history.generation === runRow.reportTimingStamp?.generation
          : run.contractReports?.[path]?.failed === false && value.updatedAt === run.endedAt
      )
        ? [[path, value.durationMs]]
        : [],
    ),
  );
  return { runId: run.id, measuredOn: run.request.expectedHead, timings };
}
export const history = internalQuery({
  args: { projectId: v.id('hostedProjects'), candidateId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    await intentTestContext(ctx, input);
    return canonicalPayload(await historyBasis(ctx, input.projectId));
  },
});
/** History confirmation has its own read/CAS path so exact-Candidate B2.1
 * confirmation remains unchanged, including for old callers. */
export const confirmHistory = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    candidateId: v.string(),
    contract: v.string(),
    authorityEpoch: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { actor, intent, candidate } = await intentTestContext(ctx, input);
    const contract = intentTestContractSchema.parse(JSON.parse(input.contract));
    const prior = intent.testContracts?.find(item => item.operationId === contract.operationId);
    if (prior) {
      invariant(
        prior.request === contract.request,
        'WORK_OPERATION_CHANGED',
        'Replay the original confirmation.',
      );
      return canonicalPayload({ intentId: intent.id, contract: prior, gate: 'unchanged' });
    }
    await hostedWriteProject(ctx, input.projectId, actor, input.authorityEpoch);
    const basis = await historyBasis(ctx, input.projectId);
    invariant(
      contract.timingBasis === 'history' &&
        contract.candidateId === candidate.id &&
        basis &&
        basis.runId === contract.runId &&
        basis.measuredOn === contract.measuredOn &&
        contract.tests.every(test => basis.timings[test.path] === test.durationMs),
      'CONTRACT_TIMING_MISSING',
      'Confirm the current historical timing proposal.',
    );
    invariant(
      (latestTestContract(intent)?.version ?? 0) + 1 === contract.version,
      'WORK_STALE',
      'Read the current contract version.',
    );
    await writeHostedRecord(ctx, {
      projectId: input.projectId,
      actor,
      authorityEpoch: input.authorityEpoch,
      expectedVersion: intent.version,
      record: {
        ...intent,
        version: intent.version + 1,
        testContracts: [...(intent.testContracts ?? []), contract],
      },
    });
    return canonicalPayload({ intentId: intent.id, contract, gate: 'unchanged' });
  },
});

import {
  retainLandingProgress,
  recordLandingObservation,
  type LandingRow,
} from './projectHostedLandingStore';
import { finishRow, wakeLandingOrderWaiters } from './projectHostedFinishWake';
import { releaseCohortHolds } from './projectHostedLandingCohortHold';
import { semanticPayload } from '../src/semantic-payload';
import type { HostedLandingState } from '../src/hosted-landing';
import { openMainRedHold } from '../src/hosted-acceptance';

/** Publication already validated the exact attempt. A main-red hold is an event
 * wait: retain ordinary observations without the generic ready/finish wakes. */
export async function holdMainRed(ctx: MutationCtx, row: LandingRow, next: HostedLandingState) {
  if (row.alarm) await cancelPendingTask(ctx, row.alarm.taskId);
  const finish = await finishRow(ctx, { projectId: row.projectId, submissionId: row.submissionId });
  if (finish?.wake) {
    await cancelPendingTask(ctx, finish.wake?.taskId);
    await ctx.db.patch(finish._id, { wake: null });
  }
  await retainLandingProgress(ctx, next);
  await recordLandingObservation(ctx, next, finish ? JSON.parse(finish.value).pending : null);
  await ctx.db.patch(row._id, {
    runnable: false,
    hold: 'main-red',
    alarm: null,
    orderLive: undefined,
    orderWaited: undefined,
    // Parked, it no longer decides its own run (10b0a94b): it must not fill a check slot or keep
    // peers' cohort holds until main recovers.
    deciding: undefined,
    // Its alarm and wake are gone: a reservation it kept would park later landings of the
    // same files on a row nothing drives, as Fix D's park already clears (review e7137e30 4b).
    reservedUntil: undefined,
    // The hold's record (Item 687d1eda): rides this patch; releaseMainHolds closes it.
    mainRedHolds: openMainRedHold(row.mainRedHolds, 'publication', new Date().toISOString()),
    value: semanticPayload(next),
  });
  // A held entry gives up its submission-order place; the next waiter re-reads the gate.
  if (row.orderWaited) await wakeLandingOrderWaiters(ctx, row);
  if (row.deciding !== undefined) await releaseCohortHolds(ctx, row.projectId);
}
