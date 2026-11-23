// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingState } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { cancelledUsageRepository, pendingRunnerState } from './cancelledRunUsage';
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

type CancelledOwner = NonNullable<Awaited<ReturnType<typeof cancelledRunOwner>>>;
type OwnerChange = CancelledOwnerChange & { owner: CancelledOwner; accounting: CancelledOwner['accounting'] };

function ownerChange(
  owner: CancelledOwner,
  state: HostedLandingState,
  pending: number,
  runId: string,
): OwnerChange {
  const accounting = {
    ...owner.accounting,
    pending,
    ...(!('runId' in owner.row) || !owner.row.runId || owner.row.runId === runId
      ? { lastCancelled: runId }
      : {}),
  };
  return {
    owner,
    accounting,
    before: owner.state,
    state,
    beforePending: owner.accounting.pending,
    pending,
    statsBaseline: owner.accounting.statsBaseline,
  };
}

/** Write canonical usage once, including any recovery input from the derived
 * day. This is deliberately outside writeLanding so it cannot run queue work. */
async function persistOwnerChanges(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  changes: OwnerChange[],
) {
  const missed = await adjustCancelledRunDays(ctx, projectId, changes);
  for (const { owner, accounting, before, state } of changes) {
    const runnerAccounting = { ...accounting };
    const baseline = missed.get(state.id);
    if (baseline) runnerAccounting.statsBaseline = baseline;
    else delete runnerAccounting.statsBaseline;
    await ctx.db.patch(owner.row._id, {
      runnerAccounting,
      ...(before === state ? {} : { value: canonicalPayload(state) }),
    });
  }
  return changes.map(({ state, pending }) => pendingRunnerState(state, pending));
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
  const awaitsProvider = Boolean(cancelledUsageRepository(run.configuration));
  const changes: OwnerChange[] = [];
  const roots = new Set<string>();
  for (const id of row.cancelledUsage.submissions) {
    const owner = await cancelledRunOwner(ctx, projectId, id);
    if (!owner || roots.has(owner.accounting.root)) continue;
    roots.add(owner.accounting.root);
    const state: HostedLandingState = awaitsProvider
      ? owner.state
      : {
          ...owner.state,
          counts: { ...owner.state.counts, discardedRunnerUnknown: 'superseded-check-execution-unreported' },
        };
    changes.push(ownerChange(owner, state, owner.accounting.pending + Number(awaitsProvider), runId));
  }
  await ctx.db.patch(row._id, { cancelledUsage: { ...row.cancelledUsage, pending: true } });
  const changed = await persistOwnerChanges(ctx, projectId, changes);
  await correctLandingRunnerCosts(ctx, projectId, changed);
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
  const changes = [...owners.values()].map(({ owner, shares }) => {
    const seconds = (usage.seconds * shares) / submissions.length;
    const state = {
      ...owner.state,
      counts: {
        ...owner.state.counts,
        discardedRunnerSeconds: (owner.state.counts?.discardedRunnerSeconds ?? 0) + seconds,
      },
    };
    return ownerChange(
      owner,
      state,
      Math.max(0, owner.accounting.pending - Number(Boolean(row.cancelledUsage?.pending))),
      run.id,
    );
  });
  const corrected = await persistOwnerChanges(ctx, row.projectId, changes);
  await adjustClosedRunCi(ctx, row.projectId, { id: run.id, startedAt: row._creationTime }, usage.seconds);
  await correctLandingRunnerCosts(ctx, row.projectId, corrected);
  run.cost = { status: 'observed', ...usage, estimatedCostUsd: null };
  await ctx.db.patch(row._id, {
    value: canonicalPayload(run),
    cancelledUsage: { submissions, pending: true, corrected: true },
  });
}
