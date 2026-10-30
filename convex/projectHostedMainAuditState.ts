// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { hostedCheckTerminal, hostedCheckRunSchema, type HostedCheckRun } from '../src/hosted-check';
import { mainGateSchema, type MainGate } from '../src/bet2-gate';
import {
  auditDebt,
  auditDue,
  auditMetadata,
  mainAuditStallMs,
  defaultMainAuditSettings,
  docsGate,
  fullGate,
  mainAuditSettingsSchema,
} from '../src/main-audit';
import { hostedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { recordLandingObservation, wakeLandingQueue } from './projectHostedLandingEvents';

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
export async function mainRed(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  return Boolean((await auditRow(ctx, projectId))?.red);
}
export async function armAudit(
  ctx: MutationCtx,
  row: Doc<'projectHostedMainAudits'>,
  at: number,
  extra: { retry?: boolean } = {},
) {
  if (row.wake && row.wake.at <= at) return;
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
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
) {
  await ctx.db.insert('projectHostedMainAuditEvents', {
    projectId: row.projectId,
    kind,
    at,
    head,
    runId,
    sequence,
  });
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
    await ctx.db.patch(row._id, { hold: undefined, runnable: true, value: canonicalPayload(state) });
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
    };
    await ctx.db.patch(row._id, patch);
    row = { ...row, ...patch };
  }
  if (!receipt.crossHeadProof && fullGate(run) && !docsGate(run)) {
    if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
    await ctx.db.patch(row._id, {
      lastGreen: { sequence: receipt.snapshot.revision, head: receipt.candidate.head, runId: run.id },
      unaudited: { count: 0, firstAt: null },
      red: undefined,
      debt: false,
      wake: undefined,
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
      );
      await releaseMainHolds(ctx, projectId);
    }
    return;
  }
  if (
    !receipt.crossHeadProof &&
    docsGate(run) &&
    row.lastGreen?.head === receipt.previous.head &&
    !row.red &&
    !row.unaudited?.count
  ) {
    await ctx.db.patch(row._id, {
      lastGreen: { ...row.lastGreen, sequence: receipt.snapshot.revision, head: receipt.candidate.head },
    });
    return;
  }
  // A docs pass cannot bless an unknown or already unaudited parent.
  const docs = !receipt.crossHeadProof && docsGate(run);
  const count = (row.unaudited?.count ?? 0) + (docs ? 0 : 1);
  const firstAt = row.unaudited?.firstAt ?? (docs ? null : receipt.at);
  const settings = await auditSettings(ctx, projectId);
  await ctx.db.patch(row._id, {
    unaudited: { count, firstAt: count ? firstAt : null },
    debt: auditDebt(count, firstAt, settings),
  });
  if (count && (!row.audit || hostedCheckTerminal(row.audit)))
    await armAudit(ctx, row, auditDue(count, firstAt, settings));
}
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
    await ctx.db.patch(row._id, {
      lastGreen: { sequence: meta.sequence, head: run.request.expectedHead, runId: run.id },
      unaudited: { count, firstAt },
      red: undefined,
      debt: false,
    });
    await auditEvent(ctx, row, 'green', at, run.request.expectedHead, run.id, meta.sequence);
    await releaseMainHolds(ctx, projectId);
    if (count)
      await armAudit(
        ctx,
        { ...row, wake: undefined },
        row.wake && row.wake.at <= Date.now()
          ? Date.now()
          : auditDue(count, firstAt, await auditSettings(ctx, projectId)),
      );
  } else if (run.status === 'failed') {
    const firstAt =
      meta.firstAt && (!row.unaudited?.firstAt || meta.firstAt < row.unaudited.firstAt)
        ? meta.firstAt
        : row.unaudited!.firstAt;
    await ctx.db.patch(row._id, { unaudited: { count: row.unaudited!.count, firstAt } });
    await ctx.db.patch(row._id, {
      red: { ...row.red, since: row.red?.since ?? at, head: run.request.expectedHead, runId: run.id },
    });
    if (!row.red) await auditEvent(ctx, row, 'red', at, run.request.expectedHead, run.id, meta.sequence);
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
    await ctx.db.patch(row._id, { unaudited: { count: row.unaudited!.count, firstAt } });
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
  return {
    head: green ? row!.lastGreen!.head : (row?.audit?.head ?? null),
    result: green ? 'passed' : (active?.status ?? row?.audit?.status ?? null),
    redSince: row?.red?.since ?? null,
    redMinutes: row?.red ? Math.max(0, Date.now() - Date.parse(row.red.since)) / 60_000 : 0,
    lastGreen: row?.lastGreen ?? null,
    unaudited: pending,
    alarm:
      retainedStall || overdue
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
