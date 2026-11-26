// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { globPattern } from '../src/autonomy-policy';
import type { DeployTarget } from '../src/deploy-targets';

export const pathsAffectTarget = (target: DeployTarget, paths: readonly string[]) => {
  if (target.triggerPaths === undefined) return paths.length > 0;
  const patterns = target.triggerPaths.map(globPattern);
  return paths.some(path => patterns.some(pattern => pattern.test(path)));
};

export async function newestCompletedRow(ctx: QueryCtx, projectId: Id<'hostedProjects'>, target: string) {
  // There is at most one queued marker per target.
  const rows = await ctx.db
    .query('projectDeploys')
    .withIndex('by_project_and_target_and_sequence', q => q.eq('projectId', projectId).eq('target', target))
    .order('desc')
    .take(2);
  return rows.find(row => row.status !== 'queued') ?? null;
}

export async function newestSuccesses(ctx: QueryCtx, projectId: Id<'hostedProjects'>, target: string) {
  const rows = await ctx.db
    .query('projectDeploys')
    .withIndex('by_project_and_target_and_status_and_sequence', q =>
      q.eq('projectId', projectId).eq('target', target).eq('status', 'succeeded'),
    )
    .order('desc')
    .take(12);
  return {
    last: rows[0] ?? null,
    lastUploaded: rows.find(row => !row.unchanged) ?? null,
  };
}

export function liveSequence(row: Doc<'projectDeploys'>) {
  return row.unchanged ? (row.liveSequence ?? null) : row.sequence;
}
