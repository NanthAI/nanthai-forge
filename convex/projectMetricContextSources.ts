// SPDX-License-Identifier: Apache-2.0
import { streamQuery } from 'convex-helpers/server/pagination';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import schema from './schema';
import { capsuleIndexKind } from './projectLandingCapsuleIndex';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { metricRunKind, readMetricAttempt } from './projectMetricReadProjection';
import { metricAttemptSource, metricRequestRow } from './projectMetricSourceRow';
import type { metricRunRow } from '../src/self-metrics-run';
import type { MetricContextStream } from '../src/self-metrics-context';

type Request = Doc<'projectHostedLandingRequests'>;
type Attempt = Doc<'projectHostedLandingAttempts'>;
type Compact = Doc<'projectFinishReadRows'>;

const requestRow = (row: Request) => ({
  stream: 'requests' as const,
  sourceId: row._id,
  sourceCreatedAt: row._creationTime,
  row: metricRequestRow(row),
});
const attemptRow = (row: Attempt) => ({
  stream: 'attempts' as const,
  sourceId: row._id,
  sourceCreatedAt: row.sourceCreatedAt ?? row._creationTime,
  row: metricAttemptSource(row),
});
const compactAttempt = (row: Compact) => ({
  stream: 'attempts' as const,
  sourceId: row.sourceId,
  sourceCreatedAt: row.sourceCreatedAt ?? row._creationTime,
  row: readMetricAttempt(row) as ReturnType<typeof metricAttemptSource>,
});
const compactRun = (row: Compact) => ({
  stream: 'runs' as const,
  sourceId: row.sourceId,
  sourceCreatedAt: row.sourceCreatedAt ?? row._creationTime,
  row: JSON.parse(row.value) as ReturnType<typeof metricRunRow>,
});

export type MetricLiveRow = ReturnType<
  typeof requestRow | typeof attemptRow | typeof compactAttempt | typeof compactRun
>;
type IndexKey = (string | number)[];
type Source = {
  start: IndexKey;
  end: IndexKey;
  inclusive: boolean;
  rows: (cursor: IndexKey | null) => AsyncIterable<[MetricLiveRow, IndexKey]>;
};
export const metricRowBytes = (row: unknown) => new TextEncoder().encode(JSON.stringify(row)).length;

export function metricContextSources(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  // Metrics use the ticket's scalar evidence. The split request and selection
  // bodies contain no report fields.
  const tickets = { db: landingRequestOriginalDb(ctx.db) };
  const identities = new Map<string, MetricLiveRow | null>();
  let compact: Promise<boolean> | undefined;
  const compactAttempts = () =>
    (compact ??= ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', projectId))
      .unique()
      .then(row => Boolean(row && JSON.parse(row.value).done)));
  const remember = (stream: MetricContextStream, id: string, row: MetricLiveRow | null) => {
    identities.set(stream + ':' + id, row);
    return row;
  };
  const compactBy = async (
    kind: string,
    index: 'by_kind_and_project_and_attempt' | 'by_kind_and_project_and_run',
    id: string,
  ) =>
    ctx.db
      .query('projectFinishReadRows')
      .withIndex(index, q =>
        index === 'by_kind_and_project_and_attempt'
          ? q.eq('kind', kind).eq('projectId', projectId).eq('attemptId', id)
          : q.eq('kind', kind).eq('projectId', projectId).eq('runId', id),
      )
      .unique();

  async function resolve(stream: MetricContextStream, id: string, count: (row: unknown) => void) {
    const key = stream + ':' + id;
    if (identities.has(key)) return identities.get(key)!;
    if (stream === 'requests') {
      const row = await tickets.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_submission', q => q.eq('projectId', projectId).eq('submissionId', id))
        .unique();
      if (row) count(row);
      return remember(stream, id, row && requestRow(row));
    }
    if (stream === 'runs') {
      const row = await compactBy(metricRunKind, 'by_kind_and_project_and_run', id);
      if (row) count(row);
      return remember(stream, id, row && compactRun(row));
    }
    const row = await ctx.db
      .query('projectHostedLandingAttempts')
      .withIndex('by_project_and_attempt', q => q.eq('projectId', projectId).eq('attemptId', id))
      .unique();
    if (row) {
      count(row);
      return remember(stream, id, attemptRow(row));
    }
    const archived = await compactBy('projectHostedLandingAttempts', 'by_kind_and_project_and_attempt', id);
    if (archived) count(archived);
    return remember(stream, id, archived && compactAttempt(archived));
  }

  async function ranges(
    lookup: { kind: 'created'; stream: MetricContextStream } | { kind: 'entry'; id: string },
    context: number,
    from: number,
    to: number,
    count: (row: unknown) => void,
  ): Promise<Source[]> {
    const range = (start: IndexKey, end: IndexKey, inclusive = false) => ({
      start,
      end,
      inclusive,
      bounds: (cursor: IndexKey | null) => ({
        schema,
        startIndexKey: cursor ?? start,
        startInclusive: cursor === null,
        endIndexKey: end,
        endInclusive: inclusive,
        order: 'asc' as const,
      }),
    });
    const entry = lookup.kind === 'entry' ? lookup.id : null;
    const sources: Source[] = [];
    if (entry !== null || (lookup.kind === 'created' && lookup.stream === 'requests')) {
      const [start, end] =
        entry === null
          ? [
              [projectId, from],
              [projectId, to],
            ]
          : [
              [projectId, entry, context],
              [projectId, entry, to],
            ];
      const query = range(start!, end!);
      sources.push({
        ...query,
        async *rows(cursor) {
          for await (const [row, key] of streamQuery(tickets, {
            ...query.bounds(cursor),
            table: 'projectHostedLandingRequests',
            index: entry === null ? 'by_project' : 'by_project_and_submission',
          })) {
            count(row);
            yield [remember('requests', row.submissionId, requestRow(row))!, key as IndexKey];
          }
        },
      });
    }
    if (entry !== null || (lookup.kind === 'created' && lookup.stream === 'attempts')) {
      const useCompact = await compactAttempts();
      const kind = 'projectHostedLandingAttempts';
      const prefix = useCompact ? [kind, projectId] : [projectId];
      const query =
        entry === null
          ? range([...prefix, from], [...prefix, to])
          : range([...prefix, entry], [...prefix, entry], true);
      sources.push({
        ...query,
        async *rows(cursor) {
          if (useCompact) {
            for await (const [row, key] of streamQuery(ctx, {
              ...query.bounds(cursor),
              table: 'projectFinishReadRows',
              index:
                entry === null ? 'by_kind_and_project_and_source_time' : 'by_kind_and_project_and_submission',
            })) {
              count(row);
              yield [remember('attempts', row.attemptId!, compactAttempt(row))!, key as IndexKey];
            }
          } else {
            for await (const [row, key] of streamQuery(ctx, {
              ...query.bounds(cursor),
              table: 'projectHostedLandingAttempts',
              index: entry === null ? 'by_project' : 'by_project_and_submission_and_number',
            })) {
              count(row);
              yield [remember('attempts', row.attemptId, attemptRow(row))!, key as IndexKey];
            }
          }
        },
      });
    }
    if (lookup.kind === 'created' && lookup.stream === 'runs') {
      const query = range([metricRunKind, projectId, from], [metricRunKind, projectId, to]);
      sources.push({
        ...query,
        async *rows(cursor) {
          for await (const [row, key] of streamQuery(ctx, {
            ...query.bounds(cursor),
            table: 'projectFinishReadRows',
            index: 'by_kind_and_project_and_source_time',
          })) {
            count(row);
            yield [remember('runs', row.runId!, compactRun(row))!, key as IndexKey];
          }
        },
      });
    }
    return sources;
  }
  return { ranges, resolve };
}
