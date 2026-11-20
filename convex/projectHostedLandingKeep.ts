// SPDX-License-Identifier: Apache-2.0
/** Keep the run (Item fa2c1383): the post-acceptance sweep's keep wiring, behind its own default-off
 * switch. The rule is pure (src/stale-check-keep.ts); this module feeds it from rows the sweep
 * already holds, plus three reads memoised per sweep and made only when a checking row reaches the
 * part of the rule that needs them: the main gate, the landing-speed row (measured check costs) and,
 * only when the answer depends on it, the audit row for the fast mode. A kept run changes nothing
 * that decides what lands: acceptance, the cross-head proof and the scoped recheck are untouched. */
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { auditFreshness, auditRow, coverageLanding, mainGate } from './projectHostedMainAuditState';
import { writeLanding, type LandingRow } from './projectHostedLandingStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { writeFinish, type loadFinish } from './projectHostedFinishStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy } from '../src/autonomy-policy';
import { protectedGatePaths, reducedEvidenceActor } from '../src/contract-gate-policy';
import { docsGate, fullGate } from '../src/main-audit';
import { checkRunEntryPaths } from '../src/first-check-risk';
import { isStandardForgeCheck } from '../src/standard-check';
import { fastEffective } from '../src/landing-mode';
import { pathsOverlap } from '../src/hosted-cross-head-proof';
import { landingSpeedStateSchema } from '../src/landing-speed-alerts';
import {
  needsFastMain,
  staleCheckDisposition,
  type StaleCheckDisposition,
  type StaleCheckInput,
} from '../src/stale-check-keep';
import { checkEconomics, measuredCheckCosts } from '../src/stale-check-economics';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import type { HostedCheckRun } from '../src/hosted-check';

export { keepTheRunOn } from './projectHostedKeepSwitch';

const bestTrust = { level: 'autonomous', reason: 'upper bound' } as const;
const MAIN_STATES: StaleCheckInput['main'][] = [
  { status: 'green', debt: false },
  { status: 'red', debt: false },
  { status: 'unknown', debt: false },
  { status: 'green', debt: true },
];
/** True when the decision reads main's gate, so the sweep reads it (memoised) only then. Today's
 * unrelated keep, a coverage mover and a conflict decide without it: no new read where today keeps. */
const needsMain = (rule: StaleCheckInput) =>
  new Set(MAIN_STATES.map(main => staleCheckDisposition({ ...rule, main }).reason)).size > 1;

/** Per-sweep memo: each read happens at most once per accepted mover, and only when needed. */
export type KeepMemo = {
  gate?: Awaited<ReturnType<typeof mainGate>>;
  audit?: Doc<'projectHostedMainAudits'> | null;
  costs?: ReturnType<typeof measuredCheckCosts>;
};

export async function keepDecision(
  ctx: MutationCtx,
  memo: KeepMemo,
  input: {
    project: Doc<'hostedProjects'>;
    state: HostedLandingState;
    attempt: HostedLandingAttempt;
    finish: Awaited<ReturnType<typeof loadFinish>>['value'];
    run: HostedCheckRun;
    shardStartedAt: number | undefined;
    paths: readonly string[] | null;
    changed: readonly string[];
    globalMover: boolean;
    now: number;
  },
): Promise<StaleCheckDisposition> {
  const { project, state, attempt, run, paths, changed } = input;
  const projectId = project._id as Id<'hostedProjects'>;
  const policy = effectivePolicy(project);
  const rule: StaleCheckInput = {
    acceptance: policy.acceptance,
    // The cheap bound used by reuseDecision before any read: true only if some trust could allow it.
    reducedEvidence: reducedEvidenceActor(
      policy,
      project,
      attempt.actor,
      policy.trust?.enabled ? bestTrust : null,
    ),
    landing: {
      recovery: Boolean(input.finish.recoveryRunId || input.finish.restoreBases),
      revert: Boolean(state.request.revertOf),
      cohort: Boolean(state.batchId && !state.batchSolo),
      semanticPlan: Boolean(attempt.semanticPlan?.members.length),
    },
    run: {
      gate: docsGate(run) ? 'docs' : fullGate(run) ? 'full' : 'partial',
      standard: isStandardForgeCheck(run.check),
      direct: run.configuration.provider === 'github-actions' && !run.configuration.credential,
    },
    paths,
    changed,
    checkEntries: checkRunEntryPaths(run.check),
    globalMover: input.globalMover,
    // The mover changes which tests run for this run's check (687d1eda, the same predicate).
    coverageMover: coverageLanding(run, changed),
    // Read below only when the answer depends on it (needsMain).
    main: MAIN_STATES[0]!,
    // The same protected set acceptance reads (projectHostedAcceptancePublish): every defined check's
    // entry files plus this run's own check.
    protectedPaths: protectedGatePaths(policy, paths ? [...paths] : null, [
      run.check,
      ...(project.checkEntries ?? []),
    ]),
    economics: null,
    // Lane B: a run that shares a path with the mover keeps only until its probe answers. A batch
    // fallback member cannot be probed (precompose settlement leaves a member whose batch owns a run
    // to that run), so it takes the rule without a probe: code overlap retires it as today.
    overlapProbe: state.batchId ? undefined : 'pending',
  };
  if (needsMain(rule)) {
    const gate = (memo.gate ??= await mainGate(ctx, projectId));
    rule.main = { status: gate.status, debt: gate.debt };
  }
  let decided = staleCheckDisposition(rule);
  if (decided.action === 'cancel' && decided.reason === 'scoped-unmeasured') {
    if (memo.costs === undefined) {
      const row = await ctx.db
        .query('projectLandingSpeed')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .unique();
      const parsed = row ? landingSpeedStateSchema.safeParse(JSON.parse(row.value)) : null;
      memo.costs = measuredCheckCosts(parsed?.success ? parsed.data.samples : null);
    }
    rule.economics = checkEconomics(memo.costs, input.shardStartedAt, input.now);
    decided = staleCheckDisposition(rule);
  }
  if (needsFastMain(rule)) {
    if (memo.audit === undefined) memo.audit = await auditRow(ctx, projectId);
    const gate = (memo.gate ??= await mainGate(ctx, projectId));
    // The audit's own freshness only (no main-receipt relaxation): the proof decides at acceptance.
    rule.fastMain = fastEffective(
      policy.acceptance.landingMode,
      memo.audit?.window,
      auditFreshness(memo.audit, gate),
    );
    decided = staleCheckDisposition(rule);
  }
  return decided;
}

/** The keep's one write, in the sweep's transaction (plan 82bf7c75 section 0). An admission run held
 * no queue order: it now holds it, as the retire it replaced would have, and still settles as the
 * admission. No attempt fork (its `main` stays the checked base and its accept id stays), no cancel,
 * no finish retry. A queue check already holds order: nothing to write. */
export async function holdKeptOrder(ctx: MutationCtx, row: LandingRow, state: HostedLandingState) {
  if (row.admission?.status !== 'checking' || row.admission.kept) return false;
  const admission = { ...row.admission, kept: true as const };
  await ctx.db.patch(row._id, { admission });
  await writeLanding(
    ctx,
    { ...row, admission },
    { ...state, version: state.version + 1 },
    row.runnable,
    false,
  );
  return true;
}

/** Lane B: compose the kept Candidate on current main as advice only, through the precompose path
 * the queue already has. A conflict ends the landing with COMPOSITION_CONFLICT and releases the run;
 * a clean result is cached for the finish that follows the pass. */
/** Lane B, review 0c7f9440 finding 4: a probe stays sticky until it answers on current main. The
 * sweep skips no row with a probe still running: when main moved again, the probe's next target is
 * the new main (the same coalesced slot `precomposeWaiting` keeps for queued rows), so its job's
 * completion re-probes there before its clean answer stands. A conflict found on an older main
 * re-probes on current main before it ends the landing (projectHostedFinishCompose, review a09af93a
 * finding 2). Paths it now shares join the conflict message. */
export async function retargetKeptProbe(
  ctx: MutationCtx,
  finish: Awaited<ReturnType<typeof loadFinish>>,
  paths: readonly string[] | null,
  changed: readonly string[],
  main: { head: string; receipt: { id: string } },
) {
  const pending = finish.value.pending;
  const probe = pending?.precompose;
  if (!pending || !probe || pending.main.receiptId === main.receipt.id) return false;
  const shared = paths ? changed.filter(path => pathsOverlap([...paths], [path])) : [...changed];
  const next = {
    main: { head: main.head, receiptId: main.receipt.id },
    peerLanes: probe.next?.peerLanes ?? [],
  };
  const merged = [...new Set([...probe.paths, ...shared])].slice(0, 50);
  if (canonicalPayload(next) === canonicalPayload(probe.next ?? null) && merged.length === probe.paths.length)
    return false;
  await writeFinish(ctx, finish.row, {
    ...finish.value,
    pending: { ...pending, precompose: { ...probe, paths: merged, next } },
  });
  return true;
}

export async function probeKeptRun(
  ctx: MutationCtx,
  finish: Awaited<ReturnType<typeof loadFinish>>,
  row: LandingRow,
  paths: readonly string[] | null,
  changed: readonly string[],
  main: { head: string; receipt: { id: string } },
) {
  if (finish.value.pending) return false;
  const shared = paths ? changed.filter(path => pathsOverlap([...paths], [path])) : [...changed];
  await reserveFinishRetry(
    ctx,
    finish.row,
    finish.value,
    'CHECK_EVIDENCE_REFRESH',
    { peerLanes: [], paths: shared.slice(0, 50), runnable: row.runnable },
    main,
  );
  return true;
}
