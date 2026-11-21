// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import {
  metricContextStreams,
  type MetricContextLookup,
  type MetricContextRow,
} from '../src/self-metrics-context';
import { metricContextCoverage } from './projectMetricContextCoverage';
import { metricContextSources, metricRowBytes, type MetricLiveRow } from './projectMetricContextSources';
import {
  isRelatedMetricContext,
  metricContextAliases,
  validateMetricCursor,
  type MetricIndexKey,
  type MetricJoinCursor,
} from './projectMetricContextAliases';

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

type Position = {
  binding: string;
  lookup: number;
  range: number;
  key: MetricIndexKey | null;
  join: MetricJoinCursor | null;
};

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
    generation === (await metricContextCoverage(ctx, project, context, to)),
    'EVIDENCE_CHANGED',
    'Restart metrics with the current history coverage.',
  );
  const binding = digest(JSON.stringify([projectId, generation, context, from, to, lookups]));
  let position: Position;
  try {
    position = cursor ? JSON.parse(cursor) : { binding, lookup: 0, range: 0, key: null, join: null };
  } catch {
    invariant(false, 'EVIDENCE_CHANGED', 'Continue the original metric context selection.');
  }
  invariant(
    position?.binding === binding &&
      Number.isSafeInteger(position.lookup) &&
      position.lookup >= 0 &&
      position.lookup <= lookups.length &&
      Number.isSafeInteger(position.range) &&
      position.range >= 0 &&
      position.range <= 2,
    'EVIDENCE_CHANGED',
    'Continue the original metric context selection.',
  );
  let scanned = 0;
  let bytes = 0;
  const page: MetricContextRow[] = [];
  const seen = new Set<string>();
  const full = () => scanned >= 100 || bytes >= 512 * 1024;
  const count = (row: unknown) => {
    scanned++;
    bytes += metricRowBytes(row);
  };
  const emit = (row: MetricLiveRow) => {
    if (row.sourceCreatedAt < context || row.sourceCreatedAt >= to || seen.has(row.sourceId)) return;
    seen.add(row.sourceId);
    page.push(row);
  };
  const sources = metricContextSources(ctx, projectId);
  const aliases = metricContextAliases(ctx, projectId, context, from, to, {
    full,
    count,
    emit,
    resolve: sources.resolve,
  });
  selections: for (; position.lookup < lookups.length && !full(); position.lookup++) {
    const lookup = lookups[position.lookup]!;
    if (lookup.kind === 'run') {
      const row = await sources.resolve('runs', lookup.id, count);
      if (row) emit(row);
    } else if (lookup.kind === 'created' || lookup.kind === 'entry') {
      const ranges = await sources.ranges(lookup, context, from, to, count);
      invariant(
        position.range < ranges.length,
        'EVIDENCE_CHANGED',
        'Continue the original metric context selection.',
      );
      for (; position.range < ranges.length; position.range++) {
        const range = ranges[position.range]!;
        validateMetricCursor(position.key, range.start, range.end, range.inclusive);
        for await (const [row, key] of range.rows(position.key)) {
          if (lookup.kind !== 'created' || row.sourceCreatedAt >= from) emit(row);
          if (full()) {
            position.key = key;
            break selections;
          }
        }
        position.key = null;
      }
    } else if (isRelatedMetricContext(lookup)) {
      position.join = await aliases.join(lookup, position.join);
      if (position.join) break;
    } else {
      position.key = await aliases.select(lookup, position.key);
      if (position.key) break;
    }
    position.range = 0;
  }
  return {
    page,
    isDone: position.lookup === lookups.length,
    continueCursor: position.lookup === lookups.length ? '' : JSON.stringify(position),
  };
}
