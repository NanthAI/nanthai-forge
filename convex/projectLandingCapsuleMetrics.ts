// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { capsuleIndexKind } from './projectLandingCapsuleIndex';
import { capsuleKind } from './projectLandingCapsuleStore';
import { readMetricAttempt } from './projectMetricReadProjection';
import { invariant } from '../src/errors';
const prefix = 'metric-attempts-v1:';
/** Index preparation copies original source creation times. Packing preserves these scalar rows. */
export async function capsuleMetricsPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  from: number,
  to: number,
  cursor: string | null,
) {
  const index = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', projectId))
    .unique();
  if (!index || !JSON.parse(index.value).done) return null;
  let selected = cursor;
  if (cursor) {
    if (!cursor.startsWith(prefix)) {
      const archived = await ctx.db
        .query('projectFinishReadRows')
        .withIndex('by_kind_and_project_and_submission', q =>
          q.eq('kind', capsuleKind).eq('projectId', projectId),
        )
        .first();
      invariant(
        !archived,
        'CLI_UPGRADE_REQUIRED',
        'This history cursor predates capsule support. Run nforge update and retry.',
      );
      return null;
    }
    const value = JSON.parse(cursor.slice(prefix.length));
    invariant(
      value.from === from && value.to === to && typeof value.cursor === 'string',
      'EVIDENCE_CHANGED',
      'Metric page cursor belongs to a different window or protocol.',
    );
    selected = value.cursor;
  }
  const page = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q
        .eq('kind', 'projectHostedLandingAttempts')
        .eq('projectId', projectId)
        .gte('sourceCreatedAt', from)
        .lt('sourceCreatedAt', to),
    )
    .order('desc')
    .paginate({ cursor: selected, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 512 * 1024 });
  return {
    ...page,
    page: page.page.map(readMetricAttempt),
    continueCursor: page.isDone ? '' : prefix + JSON.stringify({ from, to, cursor: page.continueCursor }),
  };
}
