// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { projectJournalHint } from './projectJournalStore';
import { coordinationJournalKey } from './projectJournalCoordinationRows';
import type { JournalIndex } from '../src/journal-segment';
import { getPage } from 'convex-helpers/server/pagination';
import schema from './schema';
import { invariant } from '../src/errors';
const prefix = 'journal-lane-metrics-v1:';
/** Scalar facts already needed for transactional version reconciliation also retain metrics.
 * Groups come from contiguous chronological capture pages, bounding overlapping index spans. */
export async function journalLaneMetricsPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  from: number,
  to: number,
  cursor: string | null,
  recordReceipts = false,
) {
  if (projectJournalHint(ctx, projectId) === false) return null;
  if (projectJournalHint(ctx, projectId) === undefined && !(await ctx.db.get(projectId))?.journalRevision)
    return null;
  invariant(
    cursor === null || cursor.startsWith(prefix),
    'CLI_UPGRADE_REQUIRED',
    'This metrics cursor predates journal support. Run nforge update and retry.',
  );
  const start = coordinationJournalKey(projectId, [from, '']),
    end = coordinationJournalKey(projectId, [to, '']);
  const position = cursor ? JSON.parse(cursor.slice(prefix.length)) : { from, to, before: end };
  invariant(
    position.from === from && position.to === to && typeof position.before === 'string',
    'BAD_ARGUMENT',
    'Continue the original metrics window.',
  );
  const before = position.before as string;
  const live = await getPage(ctx, {
    table: 'projectHostedRecords',
    index: 'by_project_and_kind',
    schema,
    startIndexKey: [projectId, 'lane', ...(position.key ?? [to])],
    startInclusive: false,
    endIndexKey: [projectId, 'lane', from],
    endInclusive: true,
    order: 'desc',
    targetMaxRows: 101,
    absoluteMaxRows: 101,
  });
  const rows = live.page;
  const indexes = recordReceipts
    ? []
    : await ctx.db
        .query('projectJournalSegments')
        .withIndex('by_project_and_record_kind_and_first', q =>
          q.eq('projectId', projectId).eq('recordKind', 'lane').lt('firstPosition', before),
        )
        .order('desc')
        .take(201);
  const facts = new Map<
    string,
    {
      key: string;
      position: [number, string];
      value: { id: string; version: number; intentId: string; revert: boolean };
    }
  >();
  for (const row of rows) {
    const key = coordinationJournalKey(projectId, [row._creationTime, row._id]);
    if (key < start || key >= before) continue;
    if (row.journalLane) {
      facts.set(row._id, {
        key,
        position: [row._creationTime, row._id],
        value: { id: row.key, version: row.version, intentId: row.parent, revert: row.journalLane.revert },
      });
      continue;
    }
    const body = await ctx.db.get(row.bodyId);
    invariant(body && body.projectId === projectId, 'EVIDENCE_CHANGED', 'Metric record body is missing.');
    const lane = JSON.parse(body.value);
    facts.set(row._id, {
      key,
      position: [row._creationTime, row._id],
      value: { id: lane.id, version: lane.version, intentId: lane.intentId, revert: !!lane.revert },
    });
  }
  for (const row of indexes) {
    const index = JSON.parse(row.value) as JournalIndex;
    const id = index.scope.slice('record:lane:'.length);
    for (const pin of index.records ?? []) {
      const key = coordinationJournalKey(projectId, [pin[2], pin[1]]);
      if (key >= start && key < before)
        facts.set(pin[1], {
          key,
          position: [pin[2], pin[1]],
          value: { id, version: pin[0], intentId: pin[4], revert: !!pin[10] },
        });
    }
  }
  const all = [...facts.values()].sort((a, b) => (a.key > b.key ? -1 : a.key < b.key ? 1 : 0)),
    page = all.slice(0, 100);
  // A boundary with no eligible facts is terminal only when the bounded index scan is exhausted.
  // Up to 100 groups from the same chronological capture page may overlap the cutoff.
  // Reading 100 extra groups makes the newest 100 facts independent of that overlap.
  const boundary = page.at(-1)?.key ?? indexes.at(-1)?.firstPosition ?? start;
  const isDone = all.length <= 100 && !live.hasMore && indexes.length < 201;
  return {
    page: page.map(row => row.value),
    isDone,
    continueCursor: isDone
      ? ''
      : prefix + JSON.stringify({ from, to, before: boundary, key: page.at(-1)?.position ?? position.key }),
  };
}
