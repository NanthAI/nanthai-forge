// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { metricAliasGeneration, metricContextKey, metricTimeSlopMs } from '../src/self-metrics-context';
import { lineSummary } from './projectLiveLineStore';
import { metricAttemptIndexReady } from './projectLandingCapsuleMetrics';
import {
  advanceBootstrapCompose,
  bootstrapFact,
  bootstrapMetricRows,
  insertBootstrapMetricRows,
  nextBootstrapRoot,
} from './projectMetricContextBootstrapRows';

type Pin = { sha256: string; size: number };
type Root = { root: string; pin: Pin; pagesLeft: number; complete: boolean };
type Phase = 'composes' | 'requests' | 'attempts' | 'runs' | 'ready' | 'granted';
export type MetricBootstrap = {
  operationId: string;
  from: number;
  through: number;
  composesThrough: number;
  epoch: number;
  cutover: string | null;
  gap: string | null;
  compactAttempts: boolean;
  phase: Phase;
  cursor: string | null;
  scannedComposes: boolean;
  pending: Root[];
  root: Root | null;
  step: number;
  composePages: number;
  aliases: number;
};
const target = { projectId: v.id('hostedProjects'), operationId: v.string() };
const progressKey = metricContextKey(metricAliasGeneration, '"bootstrap"');

async function projectFor(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const project = await ctx.db.get(projectId);
  invariant(
    project?.sourceAuthority?.mode === 'server' && !project.removal,
    'PROJECT_UNAVAILABLE',
    'Metrics bootstrap needs a server-authority project.',
  );
  return project;
}

async function current(
  ctx: QueryCtx,
  { projectId, operationId }: { projectId: Id<'hostedProjects'>; operationId: string },
) {
  const [project, record] = await Promise.all([
    projectFor(ctx, projectId),
    bootstrapFact(ctx, projectId, progressKey, operationId).unique(),
  ]);
  const state = record && (JSON.parse(record.value) as MetricBootstrap | null);
  invariant(
    state &&
      record &&
      state.epoch === project.sourceAuthority!.epoch &&
      state.cutover === (project.sourceCutover?.at ?? null),
    'EVIDENCE_CHANGED',
    'Continue the original metrics bootstrap and source authority.',
  );
  invariant(
    state.phase === 'granted' ||
      (project.metricContextBootstrap === operationId && state.gap === (project.metricContextGap ?? null)),
    'EVIDENCE_CHANGED',
    'A legacy root appeared. Restart metrics bootstrap from a new operation.',
  );
  return { state, project, record };
}

async function mainStamp(ctx: QueryCtx, project: Doc<'hostedProjects'>) {
  const [summary, main] = await Promise.all([
    lineSummary(ctx.db, project._id),
    ctx.db
      .query('projectHostedChannels')
      .withIndex('by_project_and_name', q => q.eq('projectId', project._id).eq('name', 'main'))
      .unique(),
  ]);
  const selected = main && JSON.parse(main.selection);
  const value = summary && JSON.parse(summary.value);
  invariant(
    summary &&
      value?.main?.head === selected?.head &&
      typeof selected?.head === 'string' &&
      Number.isSafeInteger(value.landingSequence) &&
      value.landingSequence === selected.sourceRevision,
    'EVIDENCE_CHANGED',
    'The live summary is behind the accepted main.',
  );
  return {
    summary,
    value,
    stamp: { generation: metricAliasGeneration, head: selected.head, sequence: value.landingSequence },
  };
}

export const begin = internalMutation({
  args: { ...target, from: v.number(), through: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { projectId, operationId, from, through } = input;
    const project = await projectFor(ctx, projectId);
    const old = await bootstrapFact(ctx, projectId, progressKey, operationId).unique();
    if (old) {
      const state = JSON.parse(old.value) as MetricBootstrap;
      invariant(
        state.from === from && state.through === through,
        'WORK_OPERATION_CHANGED',
        'Replay the original metrics bootstrap bounds.',
      );
      return old.value;
    }
    invariant(
      Number.isFinite(from) && Number.isFinite(through) && from <= through && through <= Date.now(),
      'BAD_ARGUMENT',
      'Pin a historical metrics bootstrap horizon.',
    );
    const { summary, value, stamp } = await mainStamp(ctx, project);
    const state: MetricBootstrap = {
      operationId,
      from,
      through,
      // Include legacy recoveries already visible at begin even if they
      // published after the scalar writer's deployment cutoff.
      composesThrough: Date.now() + metricTimeSlopMs,
      epoch: project.sourceAuthority!.epoch,
      cutover: project.sourceCutover?.at ?? null,
      gap: project.metricContextGap ?? null,
      compactAttempts: await metricAttemptIndexReady(ctx, projectId),
      phase: 'composes',
      cursor: null,
      scannedComposes: false,
      pending: [],
      root: null,
      step: 0,
      composePages: 0,
      aliases: 0,
    };
    await nextBootstrapRoot(ctx, projectId, state);
    await Promise.all([
      ctx.db.insert('projectMetricFacts', {
        projectId,
        key: progressKey,
        sourceCreatedAt: 0,
        sourceId: operationId,
        value: canonicalPayload(state),
      }),
      ctx.db.patch(summary._id, { value: canonicalPayload({ ...value, metricContinuity: stamp }) }),
      ctx.db.patch(projectId, { metricContextBootstrap: operationId, metricContextCoverage: undefined }),
    ]);
    return canonicalPayload(state);
  },
});

export const inspect = internalQuery({
  args: target,
  returns: v.string(),
  handler: async (ctx, input) => {
    const { state, project } = await current(ctx, input);
    return canonicalPayload({ state, owner: project.owner });
  },
});

export const advance = internalMutation({
  args: { ...target, step: v.number(), page: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { state, record } = await current(ctx, input);
    const { projectId, step, page } = input;
    if (step < state.step || state.phase === 'ready' || state.phase === 'granted') return record.value;
    invariant(step === state.step, 'EVIDENCE_CHANGED', 'Replay the original metrics bootstrap step.');
    if (state.phase === 'composes') {
      await advanceBootstrapCompose(ctx, projectId, state, page);
    } else {
      invariant(page === null, 'EVIDENCE_CHANGED', 'Only compose metadata uses an object page.');
      const result = await bootstrapMetricRows(ctx, projectId, state.phase, state);
      state.aliases += await insertBootstrapMetricRows(ctx, result.page);
      state.cursor = result.isDone ? null : result.continueCursor;
      if (result.isDone)
        state.phase = state.phase === 'requests' ? 'attempts' : state.phase === 'attempts' ? 'runs' : 'ready';
    }
    state.step++;
    const value = canonicalPayload(state);
    await ctx.db.patch(record._id, { value });
    return value;
  },
});

export const grant = internalMutation({
  args: target,
  returns: v.string(),
  handler: async (ctx, input) => {
    const { state, project, record } = await current(ctx, input);
    if (state.phase === 'granted') return record.value;
    invariant(state.phase === 'ready', 'EVIDENCE_CHANGED', 'Finish all metrics bootstrap pages first.');
    const { value, stamp } = await mainStamp(ctx, project);
    invariant(
      canonicalPayload(value.metricContinuity ?? null) === canonicalPayload(stamp),
      'EVIDENCE_CHANGED',
      'Main moved without the metrics writer. Restart the bootstrap.',
    );
    const unprojected = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_metrics_projection', q =>
        q
          .eq('projectId', input.projectId)
          .eq('metricsProjected', undefined)
          .gte('_creationTime', state.from)
          .lt('_creationTime', state.through),
      )
      .first();
    invariant(!unprojected, 'EVIDENCE_CHANGED', 'The historical horizon still contains unprojected runs.');
    state.phase = 'granted';
    const reply = canonicalPayload(state);
    await Promise.all([
      ctx.db.patch(project._id, {
        metricContextGap: undefined,
        metricContextCoverage: {
          generation: metricAliasGeneration,
          authorityEpoch: state.epoch,
          cutover: state.cutover,
          from: state.from,
          to: Number.MAX_SAFE_INTEGER,
        },
      }),
      ctx.db.patch(record._id, { value: reply }),
    ]);
    return reply;
  },
});

/** The operation token prevents a retried reset from clearing newer coverage. */
export const reset = internalMutation({
  args: target,
  returns: v.null(),
  handler: async (ctx, { projectId, operationId }) => {
    const project = await projectFor(ctx, projectId);
    if (project.metricContextBootstrap === operationId)
      await ctx.db.patch(projectId, { metricContextBootstrap: undefined, metricContextCoverage: undefined });
    return null;
  },
});
