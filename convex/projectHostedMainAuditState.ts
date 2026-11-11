// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { hostedCheckTerminal, hostedCheckRunSchema, type HostedCheckRun } from '../src/hosted-check';
import { mainGateSchema, type MainGate } from '../src/bet2-gate';
import {
  auditDebt,
  auditDue,
  auditMetadata,
  mainAuditStallMs,
  mainAuditStartNoticeAttempts,
  defaultMainAuditSettings,
  docsGate,
  fullGate,
  mainAuditSettingsSchema,
} from '../src/main-audit';
import { hostedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { firstCheckProof } from '../src/hosted-cross-head-proof';
import { recordLandingObservation, wakeLandingQueue } from './projectHostedLandingEvents';
import { holdsLandingOrder } from './projectHostedLandingOrder';
import { recordAuditRunnerSeconds } from './projectLandingSpeed';
import {
  drillClaims,
  drillInTime,
  earnedAfterGreen,
  earnedAfterUnclear,
  fastEffective,
  landingModeView,
  type AuditFreshness,
} from '../src/landing-mode';
import { effectivePolicy } from '../src/autonomy-policy';

export const auditRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
/** A reserved, versioned project execution setting; the actual runner remains key "runner". */
export async function auditSettings(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const setting = await ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', 'runner').eq('key', 'main-audit'),
    )
    .unique();
  return setting ? mainAuditSettingsSchema.parse(JSON.parse(setting.value)) : defaultMainAuditSettings;
}
export async function mainGate(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
): Promise<MainGate> {
  const row = await auditRow(ctx, projectId);
  const pending = row?.unaudited ?? { count: 0, firstAt: null };
  // During an audit the row's clock tracks the first newer counted landing;
  // the immutable run reason retains the older debt clock until it is covered.
  if (row?.audit && !hostedCheckTerminal(row.audit) && (row.lastGreen?.sequence ?? -1) < row.audit.sequence) {
    const saved = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', row.audit!.runId))
      .unique();
    if (saved) {
      const firstAt = auditMetadata(hostedCheckRunSchema.parse(JSON.parse(saved.value))).firstAt;
      if (firstAt && (!pending.firstAt || firstAt < pending.firstAt)) pending.firstAt = firstAt;
    }
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
/** Whether a fast-mode proof may carry a landing right now: policy, earned history and a fresh
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
    row?.earned,
    verifiedMain && gate.status !== 'red' ? VERIFIED_MAIN : auditFreshness(row, gate),
  );
}
export async function mainRed(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  return Boolean((await auditRow(ctx, projectId))?.red);
}
/**
 * A wake whose task already ran (a start that threw rolls back its own wake
 * clear) must not look pending forever. Only a wake overdue by a minute is
 * looked up, so the normal path reads nothing extra.
 */
async function wakeFinished(ctx: MutationCtx, wake: { taskId: Id<'_scheduled_functions'>; at: number }) {
  if (wake.at > Date.now() - 60_000) return false;
  const task = await ctx.db.system.get(wake.taskId);
  return !task || (task.state.kind !== 'pending' && task.state.kind !== 'inProgress');
}
export async function armAudit(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  at: number,
  extra: { retry?: boolean } = {},
) {
  const finished = row.wake ? await wakeFinished(ctx, row.wake) : false;
  if (row.wake && row.wake.at <= at && !finished) return;
  if (row.wake && !finished) await ctx.scheduler.cancel(row.wake.taskId);
  const taskId = await ctx.scheduler.runAfter(
    Math.max(0, at - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedMainAudit:start'),
    { projectId: row.projectId, ...extra, wakeAt: at },
  );
  await ctx.db.patch(row._id, { wake: { taskId, at } });
}
export async function clearAuditWake(ctx: MutationCtx, row: Doc<'projectHostedMainAudits'>) {
  if (row.wake) {
    await ctx.scheduler.cancel(row.wake.taskId);
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
) {
  await ctx.db.insert('projectHostedMainAuditEvents', {
    projectId: row.projectId,
    kind,
    at,
    head,
    runId,
    sequence,
    ...(drill ? { drill } : {}),
    ...(reverted !== undefined ? { reverted } : {}),
  });
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
  at: string,
  sequence: number,
  reverted = Boolean(row.red?.culprit),
) {
  if (!row.red) return { recovered: undefined, patch: {}, record: undefined };
  const drill = drillOf(row);
  return {
    recovered: { at, sequence, reverted, ...(drill ? { drill } : {}) },
    patch: row.drill ? { drill: undefined } : {},
    record: await closeDrill(ctx, row, at),
  };
}
/** Bounded fan-out; removing hold advances the indexed window without a collection scan. */
export async function releaseMainHolds(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const page = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_hold', q => q.eq('projectId', projectId).eq('hold', 'main-red'))
    .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 512 * 1024 });
  for (const row of page.page) {
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    state.version++;
    state.error = null;
    state.observation = landingObservation('queued');
    await recordLandingObservation(ctx, state, null);
    await ctx.db.patch(row._id, {
      hold: undefined,
      runnable: true,
      orderLive: holdsLandingOrder({ phase: row.phase, hold: undefined }, state) ? true : undefined,
      value: canonicalPayload(state),
    });
  }
  if (page.page.length) await wakeLandingQueue(ctx, { projectId, channel: 'main' });
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedMainAudit:releaseHeld'), {
      projectId,
    });
}
export async function noteMainLanding(
  ctx: MutationCtx,
  input: { project: Doc<'hostedProjects'>; receipt: HostedAcceptance; run: HostedCheckRun | null },
): Promise<void> {
  const { receipt, run } = input;
  if (!run || (!run.gate && !receipt.crossHeadProof) || run.status !== 'passed') return;
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
    if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
    // The proof action read this predecessor's immutable full selection; H14
    // revalidated its exact run. Bootstrap legacy full-gated projects without
    // falsely stamping the newly recomposed head as full-audited.
    const patch = {
      lastGreen: { sequence: baseline.sequence, head: baseline.head, runId: baseline.runId },
      unaudited: { count: 0, firstAt: null },
      debt: false,
      wake: undefined,
      startFailure: undefined,
    };
    await ctx.db.patch(row._id, patch);
    row = { ...row, ...patch };
  }
  if (!receipt.crossHeadProof && fullGate(run) && !docsGate(run)) {
    if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
    const ended = await recovery(
      ctx,
      row,
      receipt.at,
      receipt.snapshot.revision,
      Boolean(run.gate?.reason?.startsWith('culprit-revert:') || row.red?.culprit),
    );
    await ctx.db.patch(row._id, {
      ...ended.patch,
      lastGreen: { sequence: receipt.snapshot.revision, head: receipt.candidate.head, runId: run.id },
      unaudited: { count: 0, firstAt: null },
      red: undefined,
      debt: false,
      wake: undefined,
      startFailure: undefined,
      // An exact full pass audits this landing and every unaudited one below it.
      earned: earnedAfterGreen(row.earned, (row.unaudited?.count ?? 0) + 1, ended.recovered),
    });
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
  const settings = await auditSettings(ctx, projectId);
  // A first-check landing (Issue 7fe54c7c) is verified promptly: one coalesced
  // full audit of the newest main head, never one per landing, instead of the
  // cadence that covers contract-gated landings.
  const firstCheck = firstCheckProof(receipt.crossHeadProof) ? receipt.snapshot.revision : row.firstCheck;
  await ctx.db.patch(row._id, {
    unaudited: { count, firstAt: count ? firstAt : null },
    debt: auditDebt(count, firstAt, settings),
    ...(firstCheck !== row.firstCheck ? { firstCheck } : {}),
  });
  if (count && (!row.audit || hostedCheckTerminal(row.audit)))
    await armAudit(
      ctx,
      row,
      promptAudit({ ...row, firstCheck }) ? Date.now() : auditDue(count, firstAt, settings),
    );
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
    if (row.unaudited?.count) await armAudit(ctx, row, Date.now());
    return;
  }
  if (row.audit?.runId !== run.id || hostedCheckTerminal(row.audit)) return;
  if (run.execution) await recordAuditRunnerSeconds(ctx, projectId, run.execution.seconds);
  const meta = auditMetadata(run);
  await clearAuditWake(ctx, row);
  await ctx.db.patch(row._id, { audit: { ...row.audit, status: run.status } });
  // A full-gated fix that landed while this audit ran supersedes its verdict.
  if ((row.lastGreen?.sequence ?? -1) >= meta.sequence) {
    if (row.unaudited?.count)
      await armAudit(
        ctx,
        { ...row, wake: undefined },
        auditDue(row.unaudited.count, row.unaudited.firstAt, await auditSettings(ctx, projectId)),
      );
    return;
  }
  const at = run.endedAt ?? new Date().toISOString();
  // Legacy audit runners ran full by default. An explicit effective scope takes
  // precedence over that declaration, including an old Actions planner's docs pass.
  const fullAudit = run.gate.effective === undefined || run.gate.effective === 'full';
  if (run.status === 'passed' && fullAudit) {
    const count = Math.max(0, (row.unaudited?.count ?? 0) - meta.count);
    const firstAt = count ? row.unaudited!.firstAt : null;
    const ended = await recovery(ctx, row, at, meta.sequence);
    await ctx.db.patch(row._id, {
      ...ended.patch,
      lastGreen: { sequence: meta.sequence, head: run.request.expectedHead, runId: run.id },
      unaudited: { count, firstAt },
      red: undefined,
      debt: false,
      ...(count ? {} : { startFailure: undefined }),
      earned: earnedAfterGreen(row.earned, meta.count, ended.recovered),
    });
    await auditEvent(ctx, row, 'green', at, run.request.expectedHead, run.id, meta.sequence, ended.record);
    await releaseMainHolds(ctx, projectId);
    if (count)
      await armAudit(
        ctx,
        { ...row, wake: undefined },
        (row.wake && row.wake.at <= Date.now()) ||
          promptAudit({ firstCheck: row.firstCheck, lastGreen: { sequence: meta.sequence } })
          ? Date.now()
          : auditDue(count, firstAt, await auditSettings(ctx, projectId)),
      );
  } else if (run.status === 'failed') {
    const firstAt =
      meta.firstAt && (!row.unaudited?.firstAt || meta.firstAt < row.unaudited.firstAt)
        ? meta.firstAt
        : row.unaudited!.firstAt;
    await ctx.db.patch(row._id, { unaudited: { count: row.unaudited!.count, firstAt } });
    // An armed owner drill claims the first red in its window; a later red finds it expired (fe7d67a8).
    const claims = !row.red && drillClaims(row.drill, at);
    await ctx.db.patch(row._id, {
      red: { ...row.red, since: row.red?.since ?? at, head: run.request.expectedHead, runId: run.id },
      ...(!row.red && row.drill && !row.drill.red
        ? {
            drill: claims ? { ...row.drill, red: { at, runId: run.id, sequence: meta.sequence } } : undefined,
          }
        : {}),
    });
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
      );
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedCulprit:startRedClassification'),
      { projectId, runId: run.id },
    );
  } else {
    const firstAt =
      meta.firstAt && (!row.unaudited?.firstAt || meta.firstAt < row.unaudited.firstAt)
        ? meta.firstAt
        : row.unaudited!.firstAt;
    await ctx.db.patch(row._id, {
      unaudited: { count: row.unaudited!.count, firstAt },
      // Counted once per audit, not again for its retry.
      ...(meta.attempt === 0 ? { earned: earnedAfterUnclear(row.earned, meta.count) } : {}),
    });
    await auditEvent(ctx, row, 'stalled', at, run.request.expectedHead, run.id, meta.sequence);
    // A reduced pass is inconclusive, not a runner outage. Keep the actual run
    // result and debt; the next landing re-evaluates cadence without a hot retry.
    if (run.status === 'passed') return;
    if (row.red)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedMainAudit:stallHeld'), {
        projectId,
        runId: run.id,
        sequence: meta.sequence,
        step: run.status,
        cursor: null,
      });
    if (meta.attempt === 0) await armAudit(ctx, { ...row, wake: undefined }, Date.now(), { retry: true });
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
  const pending = row?.unaudited ?? { count: 0, firstAt: null };
  if (active) {
    const firstAt = auditMetadata(active).firstAt;
    if (firstAt && (!pending.firstAt || firstAt < pending.firstAt)) pending.firstAt = firstAt;
  }
  const green = row?.lastGreen && row.lastGreen.sequence >= (row.audit?.sequence ?? -1);
  const project = await ctx.db.get(projectId);
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
      row?.earned,
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
    settings: await auditSettings(ctx, projectId),
  };
}
