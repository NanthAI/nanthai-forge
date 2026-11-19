// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingState } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { pendingRunnerState } from './cancelledRunUsage';
import {
  adjustCancelledRunDays,
  adjustClosedRunCi,
  type CancelledOwnerChange,
} from './projectCancelledRunDay';
import { correctLandingRunnerCosts } from './projectLandingSpeed';

type Owner = Doc<'projectHostedLandingRequests'> | Doc<'projectHostedLandingDesired'>;
/** Supersession inherits the stable root on existing writes. Completion resolves
 * the latest canonical/preparing owner by index; it never walks attempt history. */
export async function cancelledRunOwner(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
) {
  const origin =
    (await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', projectId).eq('submissionId', submissionId),
      )
      .unique()) ??
    (await ctx.db
      .query('projectHostedLandingDesired')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', projectId).eq('submissionId', submissionId),
      )
      .unique());
  if (!origin) return null;
  const root = origin.runnerAccounting?.root ?? submissionId;
  const canonical = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_runner_cost_root', q =>
      q.eq('projectId', projectId).eq('runnerAccounting.root', root),
    )
    .order('desc')
    .first();
  const preparing = await ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_runner_cost_root', q =>
      q.eq('projectId', projectId).eq('runnerAccounting.root', root),
    )
    .order('desc')
    .first();
  const selected: Owner =
    canonical &&
    (!preparing ||
      canonical.submissionId === preparing.submissionId ||
      canonical._creationTime >= preparing._creationTime)
      ? canonical
      : (preparing ?? origin);
  return {
    row: selected,
    state: JSON.parse(selected.value) as HostedLandingState,
    accounting: selected.runnerAccounting ?? { root, pending: 0 },
  };
}

/** Same cancellation transaction; no terminal, version, source, order or wake field
 * changes. The run row fences duplicate pending increments by its immutable id. */
export async function markCancelledRunPending(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  runId: string,
) {
  const row = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', runId))
    .unique();
  if (!row?.cancelledUsage || row.cancelledUsage.pending || row.cancelledUsage.corrected) return;
  const run = JSON.parse(row.value) as HostedCheckRun;
  if (row.cancelledUsage.final) {
    await correctCancelledRun(ctx, row, run, row.cancelledUsage.final);
    return;
  }
  const changed = [];
  const days: CancelledOwnerChange[] = [];
  const roots = new Set<string>();
  for (const id of row.cancelledUsage.submissions) {
    const owner = await cancelledRunOwner(ctx, projectId, id);
    if (!owner || roots.has(owner.accounting.root)) continue;
    roots.add(owner.accounting.root);
    const accounting = {
      ...owner.accounting,
      pending: owner.accounting.pending + 1,
      ...(!('runId' in owner.row) || !owner.row.runId || owner.row.runId === runId
        ? { lastCancelled: runId }
        : {}),
    };
    await ctx.db.patch(owner.row._id, { runnerAccounting: accounting });
    changed.push(pendingRunnerState(owner.state, accounting.pending));
    days.push({
      before: owner.state,
      state: owner.state,
      beforePending: owner.accounting.pending,
      pending: accounting.pending,
    });
  }
  await ctx.db.patch(row._id, { cancelledUsage: { ...row.cancelledUsage, pending: true } });
  await correctLandingRunnerCosts(ctx, projectId, changed);
  await adjustCancelledRunDays(ctx, projectId, days);
}

/** Patch only usage and its private pending count. In particular this is not
 * writeLanding: an accounting event cannot schedule or advance queue work. */
export async function writeCancelledOwner(
  ctx: MutationCtx,
  owner: NonNullable<Awaited<ReturnType<typeof cancelledRunOwner>>>,
  seconds: number,
  wasPending: boolean,
  runId: string,
) {
  const accounting = {
    ...owner.accounting,
    pending: Math.max(0, owner.accounting.pending - Number(wasPending)),
    ...(!('runId' in owner.row) || !owner.row.runId || owner.row.runId === runId
      ? { lastCancelled: runId }
      : {}),
  };
  const state = {
    ...owner.state,
    counts: {
      ...owner.state.counts,
      discardedRunnerSeconds: (owner.state.counts?.discardedRunnerSeconds ?? 0) + seconds,
    },
  };
  await ctx.db.patch(owner.row._id, { runnerAccounting: accounting, value: canonicalPayload(state) });
  return { before: owner.state, state, beforePending: owner.accounting.pending, pending: accounting.pending };
}

/** One atomic correction, shared by late completion and the existing terminal hook. */
export async function correctCancelledRun(
  ctx: MutationCtx,
  row: Doc<'projectHostedCheckRuns'>,
  run: HostedCheckRun,
  usage: { seconds: number; receipt: { sha256: string; size: number } },
) {
  const submissions = row.cancelledUsage?.submissions ?? [];
  const owners = new Map<
    string,
    { owner: NonNullable<Awaited<ReturnType<typeof cancelledRunOwner>>>; shares: number }
  >();
  for (const id of submissions) {
    const owner = await cancelledRunOwner(ctx, row.projectId, id);
    if (!owner) return; // Missing attribution is not a known-zero landing cost.
    const previous = owners.get(owner.accounting.root);
    if (previous) previous.shares++;
    else owners.set(owner.accounting.root, { owner, shares: 1 });
  }
  const corrected = [];
  const changes: CancelledOwnerChange[] = [];
  for (const { owner, shares } of owners.values()) {
    const updated = await writeCancelledOwner(
      ctx,
      owner,
      (usage.seconds * shares) / submissions.length,
      Boolean(row.cancelledUsage?.pending),
      run.id,
    );
    corrected.push(pendingRunnerState(updated.state, updated.pending));
    changes.push(updated);
  }
  await adjustCancelledRunDays(ctx, row.projectId, changes);
  await adjustClosedRunCi(ctx, row.projectId, { id: run.id, startedAt: row._creationTime }, usage.seconds);
  await correctLandingRunnerCosts(ctx, row.projectId, corrected);
  run.cost = { status: 'observed', ...usage, estimatedCostUsd: null };
  await ctx.db.patch(row._id, {
    value: canonicalPayload(run),
    cancelledUsage: { submissions, pending: true, corrected: true },
  });
}
