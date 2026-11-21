// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { metricAliasGeneration } from '../src/self-metrics-context';
import { lineSummary } from './projectLiveLineStore';

export async function metricContextCoverage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  context: number,
  to: number,
) {
  const { metricContextCoverage: coverage, sourceAuthority, sourceCutover } = project;
  if (
    sourceAuthority?.mode !== 'server' ||
    coverage?.generation !== metricAliasGeneration ||
    !Number.isFinite(coverage.from) ||
    !Number.isFinite(coverage.to) ||
    coverage.authorityEpoch !== sourceAuthority.epoch ||
    coverage.cutover !== (sourceCutover?.at ?? null) ||
    coverage.from > context ||
    coverage.to < to
  )
    return null;
  const summary = await lineSummary(ctx.db, project._id);
  if (!summary) return null;
  const { main, landingSequence, metricContinuity } = JSON.parse(summary.value);
  if (
    typeof main?.head !== 'string' ||
    metricContinuity?.generation !== metricAliasGeneration ||
    metricContinuity.head !== main.head ||
    metricContinuity.sequence !== (landingSequence ?? null)
  )
    return null;
  const unprojected = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_metrics_projection', q =>
      q
        .eq('projectId', project._id)
        .eq('metricsProjected', undefined)
        .gte('_creationTime', context)
        .lt('_creationTime', to),
    )
    .first();
  return unprojected ? null : coverage.generation;
}
