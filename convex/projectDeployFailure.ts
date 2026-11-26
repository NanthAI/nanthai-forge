// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { digest } from '../src/state/hash';
import { liveSequence } from './projectDeployRows';

type Deploy = Doc<'projectDeploys'>;
type Failure = NonNullable<Deploy['failure']>;
type Diagnostic = Pick<Deploy, 'status' | 'summary' | 'smoke'> & { cause?: string };

export async function lastVerifiedLive(ctx: QueryCtx, projectId: Id<'hostedProjects'>, target: string) {
  const success = await ctx.db
    .query('projectDeploys')
    .withIndex('by_project_and_target_and_status_and_sequence', q =>
      q.eq('projectId', projectId).eq('target', target).eq('status', 'succeeded'),
    )
    .order('desc')
    .first();
  return success ? liveSequence(success) : null;
}

function fingerprint(report: Diagnostic) {
  return digest(
    JSON.stringify([
      report.status,
      report.cause || report.summary || null,
      report.cause
        ? []
        : (report.smoke?.checks
            .filter(check => !check.ok)
            .map(check => [check.name, check.status ?? null])
            .sort() ?? []),
    ]),
  );
}

export function failureDetails(
  report: Pick<Deploy, 'at' | 'runId' | 'sequence'> & Diagnostic,
  previous: Failure | null,
  lastLive: number | null,
): Failure {
  const cause = fingerprint(report);
  const sameCause = cause === previous?.cause;
  return {
    key: sameCause ? previous.key : digest(JSON.stringify([report.runId, report.sequence, cause])),
    cause,
    since: previous?.since ?? report.at,
    sinceSequence: previous?.sinceSequence ?? report.sequence,
    liveSequence: lastLive,
    ...(sameCause && previous.work ? { work: previous.work } : {}),
  };
}

export async function readFailure(ctx: QueryCtx, report: Deploy): Promise<Failure> {
  return (
    report.failure ??
    failureDetails(report, null, await lastVerifiedLive(ctx, report.projectId, report.target))
  );
}
