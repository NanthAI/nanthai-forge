// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { streamQuery } from 'convex-helpers/server/pagination';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import {
  metricContextRange,
  metricContextStreams,
  metricContextKey,
  type MetricContextLookup,
  type MetricContextRow,
  type MetricContextStream,
} from '../src/self-metrics-context';

const index = 'by_project_and_key_and_source_time_and_id';
const stream = v.union(...metricContextStreams.map(name => v.literal(name)));

export const metricContextLookupValidator = v.union(
  ...(['created', 'activity'] as const).map(kind => v.object({ kind: v.literal(kind), stream })),
  v.object({ kind: v.literal('bill-runs'), from: v.number(), to: v.number() }),
  v.object({ kind: v.literal('bill-runs-shifted'), day: v.number(), from: v.number(), to: v.number() }),
  v.object({ kind: v.literal('full-runs') }),
  ...(['entry', 'entry-retry', 'attempt-run', 'run', 'intent', 'lane'] as const).map(kind =>
    v.object({ kind: v.literal(kind), id: v.string() }),
  ),
  v.object({ kind: v.literal('failed-input'), intentId: v.string(), head: v.string() }),
  v.object({ kind: v.literal('passed-key'), reuseKey: v.string() }),
);

export function metricContextCoverage(project: Doc<'hostedProjects'>, context: number, to: number) {
  const { metricContextCoverage: coverage, sourceAuthority, sourceCutover } = project;
  return sourceAuthority?.mode === 'server' &&
    coverage &&
    typeof coverage.generation === 'string' &&
    coverage.generation.length > 0 &&
    Number.isFinite(coverage.from) &&
    Number.isFinite(coverage.to) &&
    coverage.authorityEpoch === sourceAuthority.epoch &&
    coverage.cutover === (sourceCutover?.at ?? null) &&
    coverage.from <= context &&
    coverage.to >= to
    ? coverage.generation
    : null;
}

type IndexKey = [string, string, number, string, number, string];
function comparePrefix(key: IndexKey, bound: readonly (string | number)[]) {
  for (const [index, right] of bound.entries()) {
    const left = key[index]!;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export async function metricContextPage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  input: {
    lookups: MetricContextLookup[];
    generation: string;
    context: number;
    from: number;
    to: number;
    cursor: string | null;
  },
) {
  const { _id: projectId } = project;
  const { lookups, generation, context, from, to, cursor } = input;
  invariant(lookups.length <= 100, 'BAD_ARGUMENT', 'Read metric context in batches of 100 selections.');
  invariant(
    generation === metricContextCoverage(project, context, to),
    'EVIDENCE_CHANGED',
    'Restart metrics with the current history coverage.',
  );
  const binding = digest(JSON.stringify([projectId, generation, context, from, to, lookups]));
  let position: { binding: string; lookup: number; key: IndexKey | null };
  try {
    position = cursor ? JSON.parse(cursor) : { binding, lookup: 0, key: null };
  } catch {
    invariant(false, 'EVIDENCE_CHANGED', 'Continue the original metric context selection.');
  }
  invariant(
    position?.binding === binding &&
      Number.isSafeInteger(position.lookup) &&
      position.lookup >= 0 &&
      position.lookup <= lookups.length,
    'EVIDENCE_CHANGED',
    'Continue the original metric context selection.',
  );
  let { lookup, key } = position;
  let scanned = 0,
    readBytes = 0;
  const page: MetricContextRow[] = [];
  const seen = new Set<string>();
  const bytes = (row: unknown) => new TextEncoder().encode(JSON.stringify(row)).length;
  for (; lookup < lookups.length && scanned < 100 && readBytes < 512 * 1024; lookup++) {
    const bounds = metricContextRange(lookups[lookup]!, context, from, to);
    if (bounds.start[0] > bounds.end[0]) continue;
    const [startKey, startTime] = bounds.start;
    const [endKey, endTime] = bounds.end;
    const start = [
      projectId,
      metricContextKey(generation, startKey),
      ...(startTime === undefined ? [] : [startTime]),
    ];
    const end = [
      projectId,
      metricContextKey(generation, endKey),
      ...(endTime === undefined ? [] : [endTime]),
    ];
    invariant(
      key === null ||
        (Array.isArray(key) &&
          key.length === 6 &&
          key[0] === projectId &&
          typeof key[1] === 'string' &&
          Number.isFinite(key[2]) &&
          typeof key[3] === 'string' &&
          Number.isFinite(key[4]) &&
          typeof key[5] === 'string' &&
          comparePrefix(key, start) >= 0 &&
          comparePrefix(key, end) < 0),
      'EVIDENCE_CHANGED',
      'Continue the original metric context selection.',
    );
    const rows = streamQuery(ctx, {
      schema,
      table: 'projectMetricFacts',
      index,
      startIndexKey: key ?? start,
      startInclusive: key === null,
      endIndexKey: end,
      endInclusive: false,
      order: 'asc',
    });
    let complete = true;
    for await (const [fact, indexKey] of rows) {
      if (scanned >= 100 || readBytes >= 512 * 1024) {
        complete = false;
        break;
      }
      scanned++;
      readBytes += bytes(fact);
      key = indexKey as IndexKey;
      if (fact.sourceCreatedAt < context || fact.sourceCreatedAt >= to || seen.has(fact.sourceId)) continue;
      const kind = bounds.rows
        ? (lookups[lookup] as Extract<MetricContextLookup, { kind: 'created' }>).stream
        : fact.value;
      invariant(
        metricContextStreams.some(stream => stream === kind),
        'EVIDENCE_CHANGED',
        'The metric context row kind changed.',
      );
      const range = metricContextRange(
        { kind: 'created', stream: kind as MetricContextStream },
        context,
        from,
        to,
      );
      const source = bounds.rows
        ? fact
        : await ctx.db
            .query('projectMetricFacts')
            .withIndex(index, q =>
              q
                .eq('projectId', projectId)
                .eq('key', metricContextKey(generation, range.start[0]))
                .eq('sourceCreatedAt', fact.sourceCreatedAt)
                .eq('sourceId', fact.sourceId),
            )
            .unique();
      invariant(source, 'EVIDENCE_CHANGED', 'A covered metric context row is missing.');
      if (!bounds.rows) readBytes += bytes(source);
      seen.add(source.sourceId);
      page.push({
        stream: kind as MetricContextStream,
        sourceCreatedAt: source.sourceCreatedAt,
        sourceId: source.sourceId,
        row: JSON.parse(source.value),
      });
    }
    if (!complete) break;
    key = null;
  }
  return {
    page,
    isDone: lookup === lookups.length,
    continueCursor: lookup === lookups.length ? '' : JSON.stringify({ binding, lookup, key }),
  };
}
