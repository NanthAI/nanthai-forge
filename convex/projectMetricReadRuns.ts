// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { metricRunRow } from '../src/self-metrics-run';
import type { HostedCheckRun } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { metricRunKind } from './projectMetricReadProjection';

type Cursor = { mode: 'legacy' | 'compact'; cursor: string | null; from: number; to: number };
const prefix = 'metric-runs-v1:';
function readCursor(text: string, from: number, to: number): Cursor {
  try {
    invariant(
      text.startsWith(prefix),
      'EVIDENCE_CHANGED',
      'Restart the metrics read with its original window.',
    );
    const value = JSON.parse(text.slice(prefix.length)) as Cursor;
    invariant(
      (value.mode === 'legacy' || value.mode === 'compact') &&
        (value.cursor === null || typeof value.cursor === 'string') &&
        value.from === from &&
        value.to === to,
      'EVIDENCE_CHANGED',
      'Metric page cursor belongs to a different window or protocol.',
    );
    return value;
  } catch {
    invariant(false, 'EVIDENCE_CHANGED', 'Metric page cursor belongs to a different window or protocol.');
  }
}
/** Choose one complete source for the whole read. A partly migrated window stays on canonical
 * rows, so concurrent ordinary writes cannot move a run across two paginated streams. */
export async function metricRunsPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  from: number,
  to: number,
  cursor: string | null,
) {
  const selected = cursor
    ? readCursor(cursor, from, to)
    : {
        mode: (await ctx.db
          .query('projectHostedCheckRuns')
          .withIndex('by_project_and_metrics_projection', q =>
            q
              .eq('projectId', projectId)
              .eq('metricsProjected', undefined)
              .gte('_creationTime', from)
              .lt('_creationTime', to),
          )
          .first())
          ? ('legacy' as const)
          : ('compact' as const),
        cursor: null,
        from,
        to,
      };
  const options = {
    cursor: selected.cursor,
    numItems: 100,
    maximumRowsRead: 100,
    maximumBytesRead: 512 * 1024,
  };
  if (selected.mode === 'legacy') {
    const rows = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project', q =>
        q.eq('projectId', projectId).gte('_creationTime', from).lt('_creationTime', to),
      )
      .order('desc')
      .paginate(options);
    return {
      ...rows,
      page: rows.page.map(row => metricRunRow(JSON.parse(row.value) as HostedCheckRun, row.reportFlakes)),
      continueCursor: rows.isDone
        ? ''
        : prefix + JSON.stringify({ ...selected, cursor: rows.continueCursor }),
    };
  }
  const rows = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q
        .eq('kind', metricRunKind)
        .eq('projectId', projectId)
        .gte('sourceCreatedAt', from)
        .lt('sourceCreatedAt', to),
    )
    .order('desc')
    .paginate(options);
  return {
    ...rows,
    page: rows.page.map(row => JSON.parse(row.value) as ReturnType<typeof metricRunRow>),
    continueCursor: rows.isDone ? '' : prefix + JSON.stringify({ ...selected, cursor: rows.continueCursor }),
  };
}
