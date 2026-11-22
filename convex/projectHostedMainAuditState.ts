// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { closeMainRedHold, type HostedAcceptance } from '../src/hosted-acceptance';
import { hostedCheckTerminal, hostedCheckRunSchema, type HostedCheckRun } from '../src/hosted-check';
import { matchingCheckPins } from '../src/culprit-bisect';
import { controlBuildReason } from './projectHostedMainAuditFields';
import { mainGateSchema, type MainGate } from '../src/bet2-gate';
import {
  auditDebt,
  auditMetadata,
  mainAuditStallMs,
  mainAuditStartNoticeAttempts,
  defaultMainAuditSettings,
  docsGate,
  fullGate,
  mainAuditSettingsSchema,
} from '../src/main-audit';
import {
  auditCadence,
  auditCadenceView,
  auditCoverageSchema,
  auditSchedule,
} from '../src/landing-audit-cadence';
import { storedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { firstCheckProof } from '../src/hosted-cross-head-proof';
import { recordLandingObservation, wakeLandingQueue } from './projectHostedLandingEvents';
import { holdsLandingOrder } from './projectHostedLandingOrder';
import { armLandingAlarm } from './projectHostedLandingStallWake';
import { withQueueStatusBatch } from './projectHostedQueueStatusWrite';
import { recordAuditRunnerSeconds } from './projectLandingSpeed';
import { forgetMainRedGuards, recoveredRed } from './projectGuardMainRed';
import { lineMainState } from './projectLiveLineStore';
import {
  FAST_WINDOW,
  auditCoverageDistribution,
  drillClaims,
  drillInTime,
  auditWindow,
  auditWindowGreen,
  fastEffective,
  landingModeView,
  type AuditFreshness,
} from '../src/landing-mode';
import { effectivePolicy } from '../src/autonomy-policy';
import { checkRunEntryPaths, coverageChangePaths } from '../src/first-check-risk';
import { runnerEntryPaths } from '../src/ci-status';
import { isStandardForgeCheck, STANDARD_SELECTION_INPUTS } from '../src/standard-check';

export const auditRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
/** A reserved, versioned project execution setting; the actual runner remains key "runner". */
export async function savedAuditSettings(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const setting = await ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', 'runner').eq('key', 'main-audit'),
    )
    .unique();
  return setting ? mainAuditSettingsSchema.parse(JSON.parse(setting.value)) : null;
}
export async function auditSettings(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  return (await savedAuditSettings(ctx, projectId)) ?? defaultMainAuditSettings;
}
export function auditCadenceFor(
  row: Doc<'projectHostedMainAudits'> | null,
  project: Doc<'hostedProjects'> | null,
  settings: Awaited<ReturnType<typeof savedAuditSettings>>,
) {
  return auditCadence(
    project?.autonomyPolicy?.mainAudit,
    settings,
    row?.window,
    row?.coverageSamples,
    row?.donorSignal,
  );
}
export function nextMainAudit(
  row: Doc<'projectHostedMainAudits'>,
  cadence: ReturnType<typeof auditCadenceFor>,
  now = Date.now(),
) {
  const green = row.lastGreen?.sequence ?? -1;
  const urgent = row.red
    ? 'main-red'
    : row.failedFullCheck
      ? 'failed-full-check'
      : (row.coverageThrough ?? -1) > green
        ? 'coverage-change'
        : cadence.mode === 'manual' && promptAudit(row)
          ? 'first-check'
          : undefined;
  return auditSchedule(cadence, row.unaudited!, row.lastAuditStartAt, urgent, now);
}
export async function armMainAudit(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  project: Doc<'hostedProjects'> | null,
  settings?: Awaited<ReturnType<typeof savedAuditSettings>>,
) {
  if (!row.unaudited?.count || (row.audit && !hostedCheckTerminal(row.audit))) return;
  const cadence = auditCadenceFor(
    row,
    project,
    settings === undefined ? await savedAuditSettings(ctx, row.projectId) : settings,
  );
  await armAudit(ctx, row, nextMainAudit(row, cadence).at);
}
export async function rescheduleMainAudit(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const row = await auditRow(ctx, project._id);
  if (!row?.unaudited?.count || row.wake?.retry || (row.audit && !hostedCheckTerminal(row.audit))) return;
  await clearAuditWake(ctx, row);
  await armMainAudit(ctx, { ...row, wake: undefined }, project);
}
export async function mainGate(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  savedAudit?: Doc<'projectHostedMainAudits'> | null,
): Promise<MainGate> {
  const row = savedAudit === undefined ? await auditRow(ctx, projectId) : savedAudit;
  const pending = { ...(row?.unaudited ?? { count: 0, firstAt: null }) };
  // During an audit the row's clock tracks the first newer counted landing;
  // the immutable run reason retains the older debt clock until it is covered.
  if (row?.audit && !hostedCheckTerminal(row.audit) && (row.lastGreen?.sequence ?? -1) < row.audit.sequence) {
    let firstAt: string | undefined;
    if (row.audit.firstUnverifiedAt) firstAt = row.audit.firstUnverifiedAt;
    else if (row.audit.coverage) firstAt = auditCoverageSchema.parse(JSON.parse(row.audit.coverage)).oldestAt;
    else {
      const saved = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', row.audit!.runId))
        .unique();
      if (saved) firstAt = auditMetadata(hostedCheckRunSchema.parse(JSON.parse(saved.value))).firstAt;
    }
    if (firstAt && (!pending.firstAt || firstAt < pending.firstAt)) pending.firstAt = firstAt;
  }

  return mainGateSchema.parse({
    status: row?.red ? 'red' : row?.lastGreen ? 'green' : 'unknown',
    unaudited: pending,
    debt:
      (row?.debt ?? false) ||
      (pending.count > 0 && auditDebt(pending.count, pending.firstAt, await auditSettings(ctx, projectId))),
    hold: row?.red ? 'main-red' : null,
  });
}
/** Audit freshness for fast landing mode (review note N2): the gate, plus whether an audit newer
 * than the last green ended without a verdict or could not start. From rows already read. */
export function auditFreshness(
  row: Doc<'projectHostedMainAudits'> | null,
  gate: Pick<MainGate, 'status' | 'unaudited'>,
): AuditFreshness {
  const inconclusive =
    !!row?.audit &&
    hostedCheckTerminal(row.audit) &&
    row.audit.status !== 'failed' &&
    (row.lastGreen?.sequence ?? -1) < row.audit.sequence;
  return {
    status: gate.status,
    unaudited: gate.unaudited,
    stalled: inconclusive || Boolean(row?.startFailure && row.unaudited?.count),
  };
}
/** Main's current head is itself an exact full pass (the proof's `main-receipt` baseline): verified
 * at this head, so there is no audit lag to bound. */
export const VERIFIED_MAIN: AuditFreshness = {
  status: 'green',
  unaudited: { count: 0, firstAt: null },
  stalled: false,
};
/** Whether a fast-mode proof may carry a landing right now: policy, the circuit breaker and a fresh
 * audit. `verifiedMain`: the proof's baseline is the current main receipt, re-checked by its caller. */
export async function fastLanding(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  gate: MainGate,
  verifiedMain: boolean,
) {
  const mode = effectivePolicy(project).acceptance.landingMode;
  if (mode !== 'fast') return false;
  const row = await auditRow(ctx, project._id);
  return fastEffective(
    mode,
    row?.window,
    verifiedMain && gate.status !== 'red' ? VERIFIED_MAIN : auditFreshness(row, gate),
  );
}
export async function mainRed(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  return Boolean((await auditRow(ctx, projectId))?.red);
}
export async function armAudit(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  at: number,
  extra: { retry?: boolean; failedFullCheck?: boolean } = {},
) {
  // Recover a start that rolled back its wake clear, while coalescing live wakes.
  // Reuse the overdue lookup for cancellation rather than reading the task twice.
  const task =
    row.wake && row.wake.at <= Date.now() - 60_000 ? await ctx.db.system.get(row.wake.taskId) : undefined;
  const finished = task !== undefined && (!task || !['pending', 'inProgress'].includes(task.state.kind));
  const failure = extra.failedFullCheck && !row.failedFullCheck ? { failedFullCheck: true } : null;
  if (row.wake && row.wake.at <= at && !finished) {
    if (failure) await ctx.db.patch(row._id, failure);
    return;
  }
  if (row.wake && !finished) await cancelPendingTask(ctx, row.wake.taskId, task);
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, at - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedMainAudit:start'),
    { projectId: row.projectId, ...(extra.retry ? { retry: true } : {}), wakeAt: at },
  );
  await ctx.db.patch(row._id, {
    wake: { taskId, at, ...(extra.retry ? { retry: true as const } : {}) },
    ...failure,
  });
}
export async function clearAuditWake(ctx: MutationCtx, row: Doc<'projectHostedMainAudits'>) {
  if (row.wake) {
    await cancelPendingTask(ctx, row.wake.taskId);
    await ctx.db.patch(row._id, { wake: undefined });
  }
}
export async function auditEvent(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  kind: 'green' | 'red' | 'stalled',
  at: string,
  head: string,
  runId: string,
  sequence: number,
  drill?: DrillRecord,
  reverted?: boolean,
  controlBuild?: ControlBuildEvidence,
) {
  await ctx.db.insert('projectHostedMainAuditEvents', {
    projectId: row.projectId,
    kind,
    at,
    head,
    runId,
    sequence,
    ...(row.audit?.runId === runId && row.audit.coverage ? { coverage: row.audit.coverage } : {}),
    ...(drill ? { drill } : {}),
    ...(reverted !== undefined ? { reverted } : {}),
    ...(controlBuild ? { controlBuild } : {}),
  });
  // `row` is the audit before this verdict: the first conclusive audit and later flips reach the line.
  if (kind === 'red' && !row.red) await lineMainState(ctx.db, row.projectId, { red: true, at });
  else if (kind === 'green' && (row.red || !row.lastGreen))
    await lineMainState(ctx.db, row.projectId, {
      red: false,
      at,
      // The event's own `reverted`, as Needs me's Main broke row reads it (convex/projectMainRed.ts).
      ...(row.red ? { ended: reverted === true ? ('reverted' as const) : ('fixed-on-top' as const) } : {}),
    });
}
type ControlBuildEvidence = NonNullable<Doc<'projectHostedMainAuditEvents'>['controlBuild']>;
/** The first failed, stamped audit checks one existing row. Preserve the comparison even if
 * a green result settles before the scheduled culprit search starts. */
async function compareControlBuild(
  ctx: MutationCtx,
  run: HostedCheckRun,
  green: Doc<'projectHostedMainAudits'>['lastGreen'],
): Promise<ControlBuildEvidence | undefined> {
  if (!green || !run.controlBuildKey) return;
  const saved = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q =>
      q.eq('projectId', run.projectId as Id<'hostedProjects'>).eq('runId', green.runId),
    )
    .unique();
  const parsed = saved ? hostedCheckRunSchema.safeParse(JSON.parse(saved.value)) : null;
  const prior = parsed?.success ? parsed.data : null;
  if (
    prior?.status !== 'passed' ||
    !prior.endedAt ||
    prior.request.expectedHead !== green.head ||
    !prior.controlBuildKey ||
    prior.controlBuildKey === run.controlBuildKey ||
    !matchingCheckPins(prior, run)
  )
    return;
  return {
    change: green.head === run.request.expectedHead ? 'same-source' : 'source-also-changed',
    lastGreen: {
      sequence: green.sequence,
      head: green.head,
      runId: green.runId,
      at: prior.endedAt,
      audited: prior.gate?.mode === 'audit',
    },
  };
}
type DrillRecord = NonNullable<Doc<'projectHostedMainAuditEvents'>['drill']>;
/** The owner's drill that claimed the current red, as the counter rule takes it (fe7d67a8). A claim is
 * set only on an episode's first red and cleared whenever the episode ends, so it holds while later failed
 * audits of the same episode replace `red.runId` (2026-11-10 dogfood drill: matching the run lost it). */
const drillOf = (row: Doc<'projectHostedMainAudits'>) =>
  row.red && row.drill?.red ? { startedAt: row.drill.startedAt, redAt: row.drill.red.at } : undefined;
/** Ends the drill that claimed the current red: its record goes on the red event (one indexed read)
 * and is returned for the event that ended it. The caller clears `drill` in its own patch. */
export async function closeDrill(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  recoveredAt: string | null,
): Promise<DrillRecord | undefined> {
  const drill = drillOf(row);
  if (!drill) return undefined;
  const record: DrillRecord = {
    ...drill,
    ...(recoveredAt ? { recoveredAt } : {}),
    endedAt: new Date().toISOString(),
    outcome: !recoveredAt ? 'flake' : drillInTime(drill, recoveredAt) ? 'recovered' : 'late',
  };
  const claimed = row.drill!.red!;
  const events = await ctx.db
    .query('projectHostedMainAuditEvents')
    .withIndex('by_project_and_sequence', q =>
      q.eq('projectId', row.projectId).eq('sequence', claimed.sequence),
    )
    .take(20);
  const red = events.find(event => event.kind === 'red' && event.runId === claimed.runId);
  if (red) await ctx.db.patch(red._id, { drill: record });
  return record;
}
/** The recovery fields of a verdict that ends a red episode, the drill it closes, and its event record. */
async function recovery(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  head: string,
  at: string,
  sequence: number,
  reverted = revertDecided(row.red),
) {
  if (!row.red) return { recovered: undefined, patch: {}, record: undefined };
  const drill = drillOf(row);
  return {
    recovered: { at, sequence, reverted, ...(drill ? { drill } : {}) },
    patch: { ...(row.drill ? { drill: undefined } : {}), lastRed: recoveredRed(row.red, head, at) },
    record: await closeDrill(ctx, row, at),
  };
}
/** Bounded fan-out; removing hold advances the indexed window without a collection scan.
 * Switch off (FORGE_QUEUE_PARK_ON_MAIN_RED): main's release, inline in the mutation that turned
 * main green, 100 rows a page. Switch on: parking can hold many entries, so the green mutation
 * only checks that one is held (the same one indexed read as an empty page) and releases them in
 * scheduled pages of 25 under one queue-status flush, so publication never carries the fan-out.
 * Every released row is one direct patch plus one observation, never a full landing write. */
export async function releaseMainHolds(ctx: MutationCtx, projectId: Id<'hostedProjects'>, scheduled = false) {
  const held = () =>
    ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_hold', q => q.eq('projectId', projectId).eq('hold', 'main-red'));
  // Either park switch can hold many entries (Item 687d1eda fix D, and its queue-check follow-up).
  const park = parkOnMainRed() || parkExactOnMainRed();
  if (park && !scheduled) {
    if (await held().first())
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedMainAudit:releaseHeld'),
        {
          projectId,
        },
      );
    return;
  }
  const release = async () => {
    const page = await releaseHeldPage(ctx, projectId, 'main-red', park ? 25 : 100, park);
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedMainAudit:releaseHeld'),
        {
          projectId,
        },
      );
  };
  await (park ? withQueueStatusBatch(ctx, release) : release());
}
/** One page of held rows back into the queue (its `hold` index advances as rows leave it), then one
 * queue wake when any row was released. `rearmReady`: a publication hold (`ready`) also gets its
 * alarm back. Shared by the main-red release and the CI-down hold's probe and release. */
export async function releaseHeldPage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  hold: 'main-red' | 'ci-down',
  numItems: number,
  rearmReady: boolean,
) {
  const page = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_hold', q => q.eq('projectId', projectId).eq('hold', hold))
    .paginate({ cursor: null, numItems, maximumRowsRead: 100, maximumBytesRead: 512 * 1024 });
  const park = rearmReady;
  let released = false;
  const ids: string[] = [];
  for (const row of page.page) {
    // An ended entry never resumes (a withdrawn or superseded park must not land): drop its hold.
    if (row.phase === 'landed' || row.phase === 'terminal-failed') {
      await ctx.db.patch(row._id, { hold: undefined });
      continue;
    }
    released = true;
    ids.push(row.submissionId);
    const state = storedLandingStateSchema.parse(JSON.parse(row.value));
    state.version++;
    state.error = null;
    state.observation = landingObservation('queued');
    // A parked admission (fix D: queued, no alarm; parkLanding cancelled it) gets back what
    // parking took: its cohort window place and a stall alarm. Release is progress, so the
    // alarm counts 15 min from now, not from before the red episode (no false stall at once).
    // With the switch on a publication hold gets its alarm back too.
    const parked = row.phase === 'queued' && !row.alarm;
    const rearm = parked || (park && row.phase === 'ready');
    const now = new Date().toISOString();
    if (rearm) state.timing = { submittedAt: state.at, ...state.timing, ciProgressAt: now };
    await recordLandingObservation(ctx, state, null);
    await ctx.db.patch(row._id, {
      hold: undefined,
      runnable: true,
      orderLive: holdsLandingOrder({ phase: row.phase, hold: undefined }, state) ? true : undefined,
      ...(rearm ? { alarm: await armLandingAlarm(ctx, row, now) } : {}),
      ...(parked ? { batchable: cohortPlace(row, state) } : {}),
      // Closes the hold's record (Item 687d1eda): the receipt carries held and released times.
      ...(hold === 'main-red' && row.mainRedHolds
        ? { mainRedHolds: closeMainRedHold(row.mainRedHolds, now) }
        : {}),
      value: canonicalPayload(state),
    });
  }
  if (released) await wakeLandingQueue(ctx, { projectId, channel: 'main' });
  return { released, isDone: page.isDone, ids };
}
/** writeLanding's cohort window rule for a queued entry, from the row in hand (0 reads): parking
 * kept `batchSelection`, which writeLanding sets whenever the attempt defers its check. */
const cohortPlace = (
  row: Doc<'projectHostedLandingRequests'>,
  state: { batchId?: string; batchSolo?: unknown },
) =>
  Boolean(
    row.batchSelection &&
    !state.batchId &&
    !state.batchSolo &&
    row.admission?.status !== 'failed' &&
    !(row.admission?.full && row.admission.status === 'passed' && !row.admission.reuse),
  );
/** A landing that changes which tests run, or how (Item 687d1eda). Its own check ran under the old
 * selection or executor, so it never earns main's green: the next full audit decides. Unknown paths
 * (null) count as a change; `undefined` is a caller with exact full main evidence (seed). */
export function coverageLanding(run: HostedCheckRun, paths: readonly string[] | null | undefined) {
  if (paths === undefined) return false;
  if (paths === null) return true;
  const entries = [
    ...checkRunEntryPaths(run.check),
    ...runnerEntryPaths(run.configuration),
    ...(isStandardForgeCheck(run.check) ? STANDARD_SELECTION_INPUTS : []),
  ];
  return coverageChangePaths(paths, entries).length > 0;
}
export async function noteMainLanding(
  ctx: MutationCtx,
  input: {
    project: Doc<'hostedProjects'>;
    receipt: HostedAcceptance;
    run: HostedCheckRun | null;
    /** A cohort contributes one checked tree and several accepted revisions. */
    firstSequence?: number;
    /** The landed change's paths, already read by the caller; see coverageLanding. */
    paths?: readonly string[] | null;
  },
): Promise<void> {
  const { receipt, run } = input;
  if (!run || (!run.gate && !receipt.crossHeadProof) || run.status !== 'passed') {
    // An ungated run (no run.gate: machine runners, credentialed Actions) keeps no audit bookkeeping:
    // nothing counts it, audits it or clears a red with it. A coverage landing only pins firstCheck,
    // so reuse never takes its own run as main's baseline (Item 687d1eda, review 0594f115 F4); the
    // next landing's own full run, under the new selection, is the next baseline. coverageLanding
    // reads only the paths the caller already has: an ordinary ungated landing still reads nothing.
    if (run?.status === 'passed' && coverageLanding(run, input.paths)) {
      const row = await auditRow(ctx, input.project._id);
      if (!row)
        await ctx.db.insert('projectHostedMainAudits', {
          projectId: input.project._id,
          firstCheck: receipt.snapshot.revision,
        });
      else if (row.firstCheck !== receipt.snapshot.revision)
        await ctx.db.patch(row._id, { firstCheck: receipt.snapshot.revision });
    }
    return;
  }
  const projectId = input.project._id;
  let row = await auditRow(ctx, projectId);
  if (!row) {
    const id = await ctx.db.insert('projectHostedMainAudits', { projectId });
    row = (await ctx.db.get(id))!;
  }
  // Machine-lease expiry settles its own operation rather than using the shared
  // completion hook. Reconcile that retained terminal result on the next landing.
  if (row.audit && !hostedCheckTerminal(row.audit)) {
    const saved = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', row!.audit!.runId))
      .unique();
    if (saved) {
      const terminal = hostedCheckRunSchema.parse(JSON.parse(saved.value));
      if (hostedCheckTerminal(terminal)) {
        await onGateRunTerminal(ctx, terminal);
        row = (await auditRow(ctx, projectId))!;
      }
    }
  }
  if ((row.lastGreen?.sequence ?? -1) >= receipt.snapshot.revision) return;
  const baseline = receipt.crossHeadProof?.audit;
  if (baseline?.source === 'main-receipt' && (row.lastGreen?.sequence ?? -1) < baseline.sequence) {
    if (row.wake) await cancelPendingTask(ctx, row.wake.taskId);
    // The proof action read this predecessor's immutable full selection; H14
    // revalidated its exact run. Bootstrap legacy full-gated projects without
    // falsely stamping the newly recomposed head as full-audited.
    const patch = {
      lastGreen: { sequence: baseline.sequence, head: baseline.head, runId: baseline.runId },
      unaudited: { count: 0, firstAt: null },
      pendingFirstSequence: undefined,
      failedFullCheck: undefined,
      debt: false,
      wake: undefined,
      startFailure: undefined,
    };
    await ctx.db.patch(row._id, patch);
    row = { ...row, ...patch };
  }
  const coverage =
    !receipt.crossHeadProof && fullGate(run) && !docsGate(run) && coverageLanding(run, input.paths);
  if (!receipt.crossHeadProof && fullGate(run) && !docsGate(run) && !coverage) {
    if (row.wake) await cancelPendingTask(ctx, row.wake.taskId);
    const ended = await recovery(
      ctx,
      row,
      receipt.candidate.head,
      receipt.at,
      receipt.snapshot.revision,
      Boolean(run.gate?.reason?.startsWith('culprit-revert:')) || revertDecided(row.red),
    );
    await ctx.db.patch(row._id, {
      ...ended.patch,
      lastGreen: { sequence: receipt.snapshot.revision, head: receipt.candidate.head, runId: run.id },
      unaudited: { count: 0, firstAt: null },
      pendingFirstSequence: undefined,
      failedFullCheck: undefined,
      red: undefined,
      debt: false,
      wake: undefined,
      startFailure: undefined,
      // An exact full pass audits this landing and every unaudited one below it.
      window: auditWindowGreen(
        row.window,
        (row.unaudited?.count ?? 0) + 1,
        ended.record?.redAt
          ? { startedAt: ended.record.startedAt, redAt: ended.record.redAt, recoveredAt: receipt.at }
          : undefined,
      ),
      earned: undefined,
    });
    await clearFixedNotices(ctx, input.project, receipt.snapshot.revision);
    if (row.red) {
      await auditEvent(
        ctx,
        row,
        'green',
        receipt.at,
        receipt.candidate.head,
        run.id,
        receipt.snapshot.revision,
        ended.record,
        ended.recovered?.reverted,
      );
      await releaseMainHolds(ctx, projectId);
    }
    return;
  }
  if (
    !receipt.crossHeadProof &&
    docsGate(run) &&
    (row.lastGreen?.coveredHead ?? row.lastGreen?.head) === receipt.previous.head &&
    !row.red &&
    !row.unaudited?.count
  ) {
    await ctx.db.patch(row._id, {
      // Keep the full run's exact head for reuse, timing evidence and culprit recovery.
      // Only the coverage frontier advances through the already-approved docs-only pass.
      lastGreen: {
        ...row.lastGreen!,
        sequence: receipt.snapshot.revision,
        coveredHead: receipt.candidate.head,
      },
    });
    return;
  }
  // A docs pass cannot bless an unknown or already unaudited parent.
  const docs = !receipt.crossHeadProof && docsGate(run);
  const count = (row.unaudited?.count ?? 0) + (docs ? 0 : 1);
  const firstAt = row.unaudited?.firstAt ?? (docs ? null : receipt.at);
  const firstSequence = input.firstSequence ?? receipt.snapshot.revision;
  const firstNewerAt =
    row.red &&
    !row.red.firstNewerAt &&
    !docs &&
    firstSequence > (row.red.sequence ?? row.audit?.sequence ?? Infinity)
      ? receipt.at
      : undefined;
  const settings = await savedAuditSettings(ctx, projectId);
  // firstCheck also guards reuse. Only a change to coverage bypasses automatic cadence.
  const firstCheck =
    firstCheckProof(receipt.crossHeadProof) || coverage ? receipt.snapshot.revision : row.firstCheck;
  const patch = {
    unaudited: { count, firstAt: count ? firstAt : null },
    pendingFirstSequence:
      row.lastGreen || docs || row.unaudited?.firstAt ? row.pendingFirstSequence : firstSequence,
    ...(firstNewerAt && row.red ? { red: { ...row.red, firstNewerAt } } : {}),
    debt: auditDebt(count, firstAt, settings ?? defaultMainAuditSettings),
    ...(firstCheck !== row.firstCheck ? { firstCheck } : {}),
    ...(coverage ? { coverageThrough: receipt.snapshot.revision } : {}),
  };
  await ctx.db.patch(row._id, patch);
  await armMainAudit(ctx, { ...row, ...patch }, input.project, settings);
}
/** Main red's failing files, from the failed audit's retained summary (Item 687d1eda): at most
 * RED_TESTS names and how many more, so a landing that fails only on them can wait for green. */
export const RED_TESTS = 20;
export function redTests(run: HostedCheckRun) {
  const files = [
    ...new Set(
      run.contractReports
        ? Object.entries(run.contractReports).flatMap(([file, report]) => (report.failed ? [file] : []))
        : (run.testFiles?.failed ?? []).map(item => item.file),
    ),
  ].sort();
  const count = Math.max(files.length, run.testFiles?.counts.failed ?? 0);
  return {
    tests: files.slice(0, RED_TESTS),
    ...(count > Math.min(files.length, RED_TESTS)
      ? { moreTests: count - Math.min(files.length, RED_TESTS) }
      : {}),
  };
}
/** Main red in one reply (Item 687d1eda): since when, the failing files, why, the fix Intent, and the
 * receipt named as culprit or as the change that made the tests run. */
export function mainRedField(red: NonNullable<Doc<'projectHostedMainAudits'>['red']>) {
  const branch = redBranch(red);
  // Either park switch holds a landing that fails only on main's red (Item 687d1eda).
  const after =
    parkOnMainRed() || parkExactOnMainRed()
      ? 'A landing that fails only on these tests is not at fault; it waits and joins the queue again once main passes.'
      : 'A landing that fails only on these tests is not at fault; land it again once main passes.';
  return {
    since: red.since,
    runId: red.runId,
    tests: red.tests ?? [],
    ...(red.moreTests ? { moreTests: red.moreTests } : {}),
    reason: !red.reason
      ? 'Recovery is classifying the failed main audit.'
      : red.reasonRunId && red.reasonRunId !== red.runId
        ? `Decided for the earlier failed audit ${red.reasonRunId} in this red episode: ${red.reason}`
        : red.reason,
    ...(red.intentId ? { fixIntentId: red.intentId } : {}),
    ...(red.culprit ? { culprit: red.culprit } : {}),
    ...(red.covered ? { newlyCoveredBy: red.covered } : {}),
    branch,
    next: `${
      branch === 'reverting'
        ? red.culprit
          ? `Reverting receipt ${red.culprit}.`
          : 'Reverting the interacting landings the reason names.'
        : branch === 'reverse-held'
          ? 'Reverse held: the prepared reverse waits for a person to accept it; nothing reverts on its own.'
          : branch === 'fix-forward'
            ? red.covered
              ? `Fix forward: receipt ${red.covered} made these tests run; nothing is reverted.`
              : 'Fix forward: nothing is reverted.'
            : 'Classifying: recovery has not decided between a revert and a fix forward yet.'
    } ${after}`,
  };
}
/** Which recovery branch runs (Item 687d1eda). No reason yet: classifying. A fix Intent: fix forward (a
 * revert decision clears it, convex/projectHostedCulprit.ts). A reverse a person must accept: held.
 * Otherwise a revert is running. */
function redBranch(red: NonNullable<Doc<'projectHostedMainAudits'>['red']>) {
  if (!red.reason) return 'classifying' as const;
  if (red.intentId) return 'fix-forward' as const;
  return red.held ? ('reverse-held' as const) : ('reverting' as const);
}
/** The episode's newest decision is a revert still standing (Item 85f456c1): a culprit is named and neither a later
 * fix-forward Intent (a failed reverse hands recovery to one) nor a held reverse replaced it. A green after that is
 * 'reverted'; after a fix forward or a reverse that waits on a person it is 'fixed on top'. */
function revertDecided(red: Doc<'projectHostedMainAudits'>['red']) {
  return Boolean(red?.culprit) && redBranch(red!) === 'reverting';
}
function previousRedCause(red: Doc<'projectHostedMainAudits'>['red']) {
  if (!red) return {};
  const { tests: _tests, moreTests: _more, firstNewerAt: _newer, ...kept } = red;
  void [_tests, _more, _newer];
  return kept;
}
/** Switch FORGE_QUEUE_PARK_ON_MAIN_RED (Item 687d1eda fix D, off by default; queue-regression guard). */
export const parkOnMainRed = () => process.env.FORGE_QUEUE_PARK_ON_MAIN_RED === '1';
/** Switch FORGE_QUEUE_PARK_EXACT_ON_MAIN_RED (Item 687d1eda: queue checks, not only admission, park
 * on main's red; off by default; queue-regression guard). */
export const parkExactOnMainRed = () => process.env.FORGE_QUEUE_PARK_EXACT_ON_MAIN_RED === '1';
/** A full green main at or after a needs-fix notice's failed sequence means its fix landed, so the
 * notice clears itself in one scheduled hop (Item 593fc2d7). With no open Fix needed notice (none, or
 * only reverted ones, which wait for their Intent to land again), a green schedules nothing. A landing
 * passes the project its caller already read; an audit reads it once. */
async function clearFixedNotices(
  ctx: MutationCtx,
  project: Id<'hostedProjects'> | Doc<'hostedProjects'> | null,
  sequence: number,
) {
  const doc = typeof project === 'string' ? await ctx.db.get(project) : project;
  if (!doc?.needsFix) return;
  const open = Object.values(doc.needsFix).some(value => {
    try {
      return (JSON.parse(value) as { state?: string }).state === 'needs-fix';
    } catch {
      return false;
    }
  });
  if (!open) return;
  await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:clearFixed'), {
    projectId: doc._id,
    sequence,
  });
}
/** Records why main is red on the current episode's row, once recovery decides (Item 687d1eda). */
export async function noteRedCause(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  episode: (red: NonNullable<Doc<'projectHostedMainAudits'>['red']>) => boolean,
  /** `runId`: the failed audit recovery decided this reason for; a later failed audit of the same
   * episode may already have replaced `red.runId`. */
  cause: { reason: string; runId: string; intentId?: string; covered?: string; held?: boolean },
): Promise<boolean> {
  const row = await auditRow(ctx, projectId);
  if (!row?.red || !episode(row.red)) return false;
  await ctx.db.patch(row._id, {
    red: {
      ...row.red,
      reason: cause.reason.slice(0, 480),
      reasonRunId: cause.runId,
      ...(cause.intentId ? { intentId: cause.intentId } : {}),
      ...(cause.covered ? { covered: cause.covered } : {}),
      held: cause.held || undefined,
    },
  });
  // True only the first time this episode names its coverage landing: its event is written once.
  return Boolean(cause.covered) && row.red.covered !== cause.covered;
}
/** An unaudited first-check landing is newer than the last green main. */
export const promptAudit = (row: { firstCheck?: number; lastGreen?: { sequence: number } }) =>
  (row.firstCheck ?? -1) > (row.lastGreen?.sequence ?? -1);
export async function onGateRunTerminal(ctx: MutationCtx, run: HostedCheckRun): Promise<void> {
  if (!run.gate || !hostedCheckTerminal(run)) return;
  if (run.gate.mode === 'probe' || run.gate.reason?.startsWith('culprit-revert:')) {
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:terminal'), {
      projectId: run.projectId as Id<'hostedProjects'>,
      runId: run.id,
    });
    if (run.gate.mode === 'probe') return;
  }
  if (run.gate?.mode !== 'audit' && !(run.status === 'failed' && fullGate(run))) return;
  const projectId = run.projectId as Id<'hostedProjects'>;
  const row = await auditRow(ctx, projectId);
  if (!row) return;
  if (run.gate?.mode !== 'audit') {
    if (!row.unaudited?.count) return;
    if (!row.audit || hostedCheckTerminal(row.audit))
      await armAudit(ctx, row, Date.now(), { failedFullCheck: !row.red });
    else if (!row.red && !row.failedFullCheck) await ctx.db.patch(row._id, { failedFullCheck: true });
    return;
  }
  if (row.audit?.runId !== run.id || hostedCheckTerminal(row.audit)) return;
  if (run.execution) await recordAuditRunnerSeconds(ctx, projectId, run.execution.seconds);
  const meta = auditMetadata(run);
  const at = run.endedAt ?? new Date().toISOString();
  const coverage = row.audit.coverage ? auditCoverageSchema.parse(JSON.parse(row.audit.coverage)) : undefined;
  const covered = Math.max(0, meta.count - (row.audit.alreadyVerified ?? 0));
  const newerCount = Math.max(0, (row.unaudited?.count ?? 0) - covered);
  const startedOldest = row.audit.firstUnverifiedAt ?? meta.firstAt;
  // Legacy audit runners ran full by default. An explicit effective scope takes
  // precedence over that declaration, including an old Actions planner's docs pass.
  const fullAudit = run.gate.effective === undefined || run.gate.effective === 'full';
  const wallMs = Date.parse(at) - Date.parse(run.at);
  // A new run occupies one sample; replaying a retained verdict does not add physical CI work.
  const coverageSamples =
    coverage && !coverage.reused
      ? [
          ...(row.coverageSamples ?? []).slice(1 - FAST_WINDOW),
          {
            landings: coverage.landings,
            threshold: coverage.cadence.effective.landings,
            ...(wallMs >= 0 && fullAudit && ['passed', 'failed'].includes(run.status) ? { wallMs } : {}),
          },
        ]
      : row.coverageSamples;
  await clearAuditWake(ctx, row);
  const settled = { audit: { ...row.audit, status: run.status }, coverageSamples, wake: undefined };
  await ctx.db.patch(row._id, settled);
  // A full-gated fix that landed while this audit ran supersedes its verdict.
  if ((row.lastGreen?.sequence ?? -1) >= meta.sequence) {
    if (row.unaudited?.count) await armMainAudit(ctx, { ...row, ...settled }, await ctx.db.get(projectId));
    return;
  }
  if (run.status === 'passed' && fullAudit) {
    const count = newerCount;
    const firstAt = count ? row.unaudited!.firstAt : null;
    const ended = await recovery(ctx, row, run.request.expectedHead, at, meta.sequence);
    const passed = {
      ...ended.patch,
      lastGreen: { sequence: meta.sequence, head: run.request.expectedHead, runId: run.id },
      unaudited: { count, firstAt },
      pendingFirstSequence: count ? row.pendingFirstSequence : undefined,
      ...(count ? {} : { failedFullCheck: undefined }),
      red: undefined,
      debt: false,
      ...(count ? {} : { startFailure: undefined }),
      window: auditWindowGreen(
        row.window,
        covered,
        ended.record?.redAt
          ? { startedAt: ended.record.startedAt, redAt: ended.record.redAt, recoveredAt: at }
          : undefined,
      ),
      earned: undefined,
    };
    await ctx.db.patch(row._id, passed);
    // The recovery's own verdict: a green audit after a culprit revert is 'reverted', as on the landing path above
    // (Item 85f456c1: the Flow day and Needs me's Main broke row read it).
    await auditEvent(
      ctx,
      row,
      'green',
      at,
      run.request.expectedHead,
      run.id,
      meta.sequence,
      ended.record,
      ended.recovered?.reverted,
    );
    await releaseMainHolds(ctx, projectId);
    const project = await ctx.db.get(projectId);
    await clearFixedNotices(ctx, project, meta.sequence);
    if (count) await armMainAudit(ctx, { ...row, ...settled, ...passed }, project);
  } else if (run.status === 'failed') {
    const firstAt =
      startedOldest && (!row.unaudited?.firstAt || startedOldest < row.unaudited.firstAt)
        ? startedOldest
        : row.unaudited!.firstAt;
    const pending = {
      unaudited: { count: row.unaudited!.count, firstAt },
      pendingFirstSequence: row.lastGreen ? undefined : (coverage?.firstSequence ?? row.pendingFirstSequence),
    };
    // Main's own failures never teach the preflight guard set (13ea93bf), even ones learned before this
    // audit saw them: from the first landing it covers, the earliest the breakage could have landed.
    const tests = redTests(run);
    await forgetMainRedGuards(ctx, projectId, tests, firstAt);
    // An armed owner drill claims the first red in its window; a later red finds it expired (fe7d67a8).
    const claims = !row.red && drillClaims(row.drill, at);
    const controlBuild =
      !row.red && fullAudit ? await compareControlBuild(ctx, run, row.lastGreen) : undefined;
    const failed = {
      ...pending,
      red: {
        // A later failed audit of the episode replaces the failing files; the cause stays.
        ...previousRedCause(row.red),
        since: row.red?.since ?? at,
        sequence: meta.sequence,
        auditedCount: covered,
        ...(newerCount && row.unaudited?.firstAt ? { firstNewerAt: row.unaudited.firstAt } : {}),
        head: run.request.expectedHead,
        runId: run.id,
        ...(controlBuild
          ? {
              controlBuildChange: controlBuild.change,
              reason: controlBuildReason(controlBuild.change),
              reasonRunId: run.id,
            }
          : {}),
        ...tests,
      },
      window: auditWindow(row.window, {
        verdict: claims || row.drill?.red ? 'drill' : 'red',
        landings: covered,
        runId: run.id,
      }),
      earned: undefined,
      ...(!row.red && row.drill && !row.drill.red
        ? {
            drill: claims ? { ...row.drill, red: { at, runId: run.id, sequence: meta.sequence } } : undefined,
          }
        : {}),
    };
    await ctx.db.patch(row._id, failed);
    if (!row.red)
      await auditEvent(
        ctx,
        row,
        'red',
        at,
        run.request.expectedHead,
        run.id,
        meta.sequence,
        claims ? { startedAt: row.drill!.startedAt, redAt: at } : undefined,
        undefined,
        controlBuild,
      );
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedCulprit:startRedClassification'),
      { projectId, runId: run.id },
    );
    if (newerCount) await armAudit(ctx, { ...row, ...settled, ...failed }, Date.now());
  } else {
    const firstAt =
      startedOldest && (!row.unaudited?.firstAt || startedOldest < row.unaudited.firstAt)
        ? startedOldest
        : row.unaudited!.firstAt;
    const pending = {
      unaudited: { count: row.unaudited!.count, firstAt },
      pendingFirstSequence: row.lastGreen ? undefined : (coverage?.firstSequence ?? row.pendingFirstSequence),
      // Counted once per audit, not again for its retry.
      ...(meta.attempt === 0
        ? { window: auditWindow(row.window, { verdict: 'unclear', landings: 0 }), earned: undefined }
        : {}),
    };
    await ctx.db.patch(row._id, pending);
    await auditEvent(ctx, row, 'stalled', at, run.request.expectedHead, run.id, meta.sequence);
    // A reduced pass supplies no verdict. Only a runner outage retries the same head.
    if (run.status !== 'passed' && row.red)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedMainAudit:stallHeld'), {
        projectId,
        runId: run.id,
        sequence: meta.sequence,
        step: run.status,
        cursor: null,
      });
    const next = { ...row, ...settled, ...pending };
    if (run.status !== 'passed' && meta.attempt === 0) await armAudit(ctx, next, Date.now(), { retry: true });
    else if (newerCount) await armMainAudit(ctx, next, await ctx.db.get(projectId));
  }
}

export async function mainAuditStatus(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const row = await auditRow(ctx, projectId);
  const events = await ctx.db
    .query('projectHostedMainAuditEvents')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
    .order('desc')
    .take(1);
  const retainedStall =
    events[0]?.kind === 'stalled' && (!row?.lastGreen || events[0].sequence > row.lastGreen.sequence);
  let active: HostedCheckRun | undefined;
  let overdue = false;
  if (row?.audit && !hostedCheckTerminal(row.audit) && (row.lastGreen?.sequence ?? -1) < row.audit.sequence) {
    const saved = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', row.audit!.runId))
      .unique();
    if (saved) {
      active = hostedCheckRunSchema.parse(JSON.parse(saved.value));
      const callbacks = await ctx.db
        .query('projectHostedCheckCallbacks')
        .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', active!.id))
        .order('desc')
        .take(1);
      const lastProgress = Math.max(
        Date.parse(active.at),
        active.actions?.reservedAt ?? 0,
        callbacks[0]?._creationTime ?? 0,
      );
      overdue = hostedCheckTerminal(active)
        ? !['passed', 'failed'].includes(active.status)
        : Date.now() - lastProgress >= mainAuditStallMs;
    }
  }
  const pending = { ...(row?.unaudited ?? { count: 0, firstAt: null }) };
  if (active) {
    const firstAt = row?.audit?.firstUnverifiedAt ?? auditMetadata(active).firstAt;
    if (firstAt && (!pending.firstAt || firstAt < pending.firstAt)) pending.firstAt = firstAt;
  }
  const green = row?.lastGreen && row.lastGreen.sequence >= (row.audit?.sequence ?? -1);
  const project = await ctx.db.get(projectId);
  const saved = await savedAuditSettings(ctx, projectId);
  const failedStart =
    row?.startFailure &&
    row.startFailure.attempts >= mainAuditStartNoticeAttempts &&
    row.unaudited?.count &&
    !active
      ? row.startFailure
      : null;
  return {
    head: green ? (row!.lastGreen!.coveredHead ?? row!.lastGreen!.head) : (row?.audit?.head ?? null),
    result: green ? 'passed' : (active?.status ?? row?.audit?.status ?? null),
    redSince: row?.red?.since ?? null,
    redMinutes: row?.red ? Math.max(0, Date.now() - Date.parse(row.red.since)) / 60_000 : 0,
    lastGreen: row?.lastGreen ?? null,
    unaudited: pending,
    // An owner's red-audit drill in progress (fe7d67a8); its outcome lands on the audit events.
    drill: row?.drill ? { startedAt: row.drill.startedAt, redAt: row.drill.red?.at ?? null } : null,
    // One derive of the landing mode for status, the CLI and the web (src/landing-mode.ts).
    landing: landingModeView(
      project ? effectivePolicy(project).acceptance.landingMode : undefined,
      row?.window,
      auditFreshness(row, {
        status: row?.red ? 'red' : row?.lastGreen ? 'green' : 'unknown',
        unaudited: pending,
      }),
    ),
    alarm: failedStart
      ? { code: 'MAIN_AUDIT_STALLED', step: failedStart.code, runId: null, message: failedStart.message }
      : retainedStall || overdue
        ? {
            code: 'MAIN_AUDIT_STALLED',
            step:
              retainedStall && row?.audit?.status === 'passed' && events[0]?.runId === row.audit.runId
                ? 'not-full'
                : (active?.status ?? row?.audit?.status ?? 'dispatch'),
            runId: overdue ? active!.id : events[0]!.runId,
          }
        : null,
    settings: saved ?? defaultMainAuditSettings,
    cadence: auditCadenceView(auditCadenceFor(row, project, saved)),
    coverage: {
      latest: row?.audit?.coverage ? auditCoverageSchema.parse(JSON.parse(row.audit.coverage)) : null,
      ...auditCoverageDistribution(row?.coverageSamples ?? []),
    },
  };
}
