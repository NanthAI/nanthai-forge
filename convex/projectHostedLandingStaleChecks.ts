// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { predecessorStatus } from './projectHostedLandingPipeline';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import {
  loadLanding,
  loadLandingAttempt,
  forkLandingAttempt,
  insertLandingAttempt,
  writeLanding,
  type LandingRow,
} from './projectHostedLandingStore';
import { loadFinish } from './projectHostedFinishStore';
import { passRepinnedFollowers } from './projectHostedFinishWake';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { loadBatch, retryLandingBatch } from './projectHostedLandingBatchStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { cancelHostedCheck } from './projectHostedCheckCancel';
import { hostedRecordSchema } from '../src/hosted-records';
import { hostedCheckTerminal, checkCause } from '../src/hosted-check';
import {
  landingObservation,
  type HostedLandingAttempt,
  type HostedLandingState,
} from '../src/hosted-landing';
import { pathsOverlap } from '../src/hosted-cross-head-proof';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { keepTheRunOn } from './projectHostedKeepSwitch';
import { claimFinishPrecompose } from './projectHostedFinishPrecompose';
import { coverageLanding } from './projectHostedMainAuditState';
import { coverageChangePaths, firstCheckRiskPaths } from '../src/first-check-risk';
import { STANDARD_SELECTION_INPUTS } from '../src/standard-check';
import { todayKeeps } from '../src/stale-check-keep';
import {
  holdKeptOrder,
  keepDecision,
  probeKeptRun,
  retargetKeptProbe,
  type KeepMemo,
} from './projectHostedLandingKeep';

/** The existing post-acceptance transaction inspects at most eight running
 * entries. An empty indexed window reads zero documents/bytes. Source and test
 * files are never read here; this waste decision grants no acceptance proof.
 * With keep-the-run on, each kept row it probes is reserved here directly, so
 * the queued-entry precompose budget (PRECOMPOSE_ENTRIES) never starves it. */
export async function cancelStaleLandingChecks(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    sequence: number;
    receiptIds: string[];
    head: string;
    candidate: { id: string; actor: string; digest: string };
  },
) {
  let rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', 'main').eq('phase', 'checking'),
    )
    .take(HOSTED_BATCH_MEMBERS);
  if (rows.some(row => row.earlyReview)) {
    // An early held Candidate's run belongs to review evidence. Its projection
    // omits batchable, so neither ordinary checking range spends a slot on it.
    const ordinary = await Promise.all(
      [false, true].map(batchable =>
        ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_batchable_and_phase_and_sequence', q =>
            q
              .eq('projectId', input.projectId)
              .eq('channel', 'main')
              .eq('batchable', batchable)
              .eq('phase', 'checking'),
          )
          .take(HOSTED_BATCH_MEMBERS),
      ),
    );
    rows = [
      ...new Map(
        [...rows.filter(row => !row.earlyReview), ...ordinary.flat()].map(row => [row._id, row]),
      ).values(),
    ]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, HOSTED_BATCH_MEMBERS);
  }
  if (!rows.length) return 0;
  const accepted = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.candidate.actor,
    kind: 'candidate',
    key: input.candidate.id,
  });
  if (!accepted || accepted.digest !== input.candidate.digest) return 0;
  const changed = hostedRecordSchema.options[3].parse(JSON.parse(accepted.value)).governance?.paths;
  if (!changed?.length) return 0;
  const main = await hostedStartMain(ctx, input.projectId);
  const project = await ctx.db.get(input.projectId);
  const global =
    firstCheckRiskPaths(changed, [...(project?.checkEntries ?? []), ...(project?.globalRiskPaths ?? [])])
      .length > 0;
  const retired = new Set<string>();
  const keep = keepTheRunOn() && !!project;
  // Keep the run: an upper bound of `coverageLanding` for any run's check, once per mover (coverage
  // only widens with more entries). Below it, today's keep is answered before any further read.
  const coverageBound =
    keep &&
    coverageChangePaths(changed, [
      ...(project?.checkEntries ?? []),
      ...(project?.globalRiskPaths ?? []),
      ...STANDARD_SELECTION_INPUTS,
    ]).length > 0;
  const memo: KeepMemo = {};
  for (const selected of rows) {
    if (!selected.runId || retired.has(selected.runId)) continue;
    // A previous member may have retired this row's whole cohort/descendants.
    const current = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: selected.submissionId,
    });
    const { row, state } = current;
    if (
      state.phase !== 'checking' ||
      !row.runId ||
      !state.request.finish ||
      row.earlyReview ||
      state.observation.pendingReason === 'waiting-for-review'
    )
      continue;
    const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId });
    // Exact predicted-head checks already contain this acceptance, including its
    // receipt. An ancestry-only head match cannot conceal a receipt ABA.
    if (
      (attempt.main.head === main.head && attempt.main.receiptId === main.receipt.id) ||
      (attempt.main.head === input.head && input.receiptIds.includes(attempt.main.receiptId))
    )
      continue;
    // A delayed acceptance event cannot retire a run prepared on a later
    // accepted receipt, even when current main has already moved again.
    const base = await acceptanceRow(ctx, { projectId: input.projectId, receiptId: attempt.main.receiptId });
    if (base && base.sequence >= input.sequence) continue;
    const grouped =
      state.batchId && !state.batchSolo
        ? await loadBatch(ctx, { projectId: input.projectId, batchId: state.batchId })
        : null;
    // Pending predicted prefixes already contain the older train acceptances.
    // If that prefix is stale, its own retirement fences all descendants.
    if (
      grouped &&
      (await predecessorStatus(
        ctx,
        { projectId: input.projectId, batchId: grouped.batch.id },
        grouped.batch,
      )) === 'pending'
    )
      continue;
    let paths: string[] | null = null;
    if (!global || keep) {
      const record = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: state.actor,
        kind: 'candidate',
        key: attempt.candidate.id,
      });
      paths =
        record && record.digest === attempt.candidate.digest
          ? (hostedRecordSchema.options[3].parse(JSON.parse(record.value)).governance?.paths ?? null)
          : null;
      if (!keep && (!paths || !pathsOverlap(paths, changed))) continue;
    }
    // Today's keep, cohorts included, with no read beyond today's (no run, finish, gate or cost read).
    if (keep && todayKeeps({ paths, changed, globalMover: global, coverageMover: coverageBound })) continue;
    const runId = row.runId;
    const { row: runRow, run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId }, false);
    if (hostedCheckTerminal(run)) continue;
    // The bound above was loose for this run's own check: today's keep still holds.
    if (
      keep &&
      todayKeeps({ paths, changed, globalMover: global, coverageMover: coverageLanding(run, changed) })
    )
      continue;
    // Keep the run (fa2c1383, switch FORGE_QUEUE_KEEP_THE_RUN): a solo run the rule keeps goes on;
    // every cancel retires it below exactly as today. A cohort's shared run retires (cohort) unless
    // today keeps it.
    if (keep && !(state.batchId && !state.batchSolo)) {
      const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: state.id });
      // An ordinary finish attempt owns the row, as today; only a probe still running is decided.
      const probing = Boolean(finish.value.pending?.precompose);
      if (finish.value.pending && !probing) continue;
      const decided = await keepDecision(ctx, memo, {
        project: project!,
        state,
        attempt,
        finish: finish.value,
        run,
        shardStartedAt: runRow.shardStartedAt,
        paths,
        changed,
        globalMover: global,
        now: Date.now(),
      });
      if (decided.action === 'keep') {
        if (decided.holdOrder) await holdKeptOrder(ctx, row, state, input.receiptIds.at(-1));
        // Sticky: a running probe now answers on this main too; an idle one starts here.
        if (probing) await retargetKeptProbe(ctx, finish, paths, changed, main);
        else if (decided.probe) await probeKeptRun(ctx, finish, row, paths, changed, main);
        continue;
      }
      // A cancel while the probe runs: detach it (its exact-main result stays cached, as a queue
      // claim does), so the retire below proceeds as today instead of skipping the row.
      if (probing) await claimFinishPrecompose(ctx, finish.row);
    }
    if (state.batchId && !state.batchSolo) {
      const key = { projectId: input.projectId, batchId: state.batchId };
      const { batch } = grouped!;
      if (batch.phase !== 'checking' || batch.runId !== runId) continue;
      // One replacement union, retaining member sequence and the shared check.
      await retryLandingBatch(ctx, key, batch, checkCause.mainMoved);
    } else {
      const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: state.id });
      if (finish.value.pending) continue;
      await retireSoloCheck(ctx, { row, state, attempt, finish, main });
    }
    await cancelHostedCheck(ctx, { projectId: input.projectId, runId });
    retired.add(runId);
  }
  return retired.size;
}

/** Today's retire of a solo run checked on an older main: the entry goes back to the queue to
 * recompose on current main, and its finish retries there. The caller owns the run (the sweep
 * cancels it; a kept run's platform end is already terminal). No run, cancel or compose here. */
export async function retireSoloCheck(
  ctx: MutationCtx,
  input: {
    row: LandingRow;
    state: HostedLandingState;
    attempt: HostedLandingAttempt;
    finish: Awaited<ReturnType<typeof loadFinish>>;
    main: Awaited<ReturnType<typeof hostedStartMain>>;
    platformEndedAt?: number;
  },
) {
  const { row, state, attempt, finish, main } = input;
  // A kept run the sweep now retires drops its `kept` marker (review a09af93a nit 5).
  const { kept: _kept, ...retired } = row.admission ?? {};
  void _kept;
  const admission =
    row.admission?.status === 'checking'
      ? {
          ...(retired as NonNullable<typeof row.admission>),
          status: 'unavailable' as const,
          reuse: 'tried' as const,
          recheck: 'main-moved',
          ...(input.platformEndedAt === undefined ? {} : { endedAt: input.platformEndedAt }),
        }
      : row.admission;
  if (admission !== row.admission) await ctx.db.patch(row._id, { admission });
  let attemptId = state.attemptId;
  if (attempt.check) {
    // A fork's metrics-only reason names its own race, never this same-main retire (c3c69c57).
    const { crossHeadProof: _proof, check: _check, forkReason: _fork, ...pins } = attempt;
    void [_proof, _check, _fork];
    const next = {
      ...pins,
      ...(await forkLandingAttempt(ctx, state)),
      check: null,
      deferredCheck: true as const,
      operations: { check: crypto.randomUUID(), accept: crypto.randomUUID() },
    };
    await insertLandingAttempt(ctx, next);
    attemptId = next.id;
  }
  // A solo fallback member still owns its serial cohort. Keep that identity
  // so its terminal transition wakes the next member after recomposition.
  await writeLanding(
    ctx,
    { ...row, admission },
    {
      ...state,
      attemptId,
      version: state.version + 1,
      phase: 'queued',
      batchSolo: true,
      batchNeedsSoloCompose: true,
      observation: landingObservation('queued'),
      error: null,
    },
    false,
    false,
    undefined,
    // The fork keeps the old base until its finish recomposes; the mover is current main.
    { replacementReplay: { replacementCause: { kind: 'main-race', link: main.receipt.id } } },
  );
  // Publication of the replacement's durable wake and cancellation share
  // this transaction. A throw rolls both back; no process owns rescheduling.
  if (finish.row.wake) {
    await cancelPendingTask(ctx, finish.row.wake?.taskId);
    await ctx.db.patch(finish.row._id, { wake: null });
  }
  const repinnedAt = await reserveFinishRetry(
    ctx,
    finish.row,
    finish.value,
    'CHECK_EVIDENCE_REFRESH',
    undefined,
    main,
  );
  await passRepinnedFollowers(ctx, row, repinnedAt);
}
