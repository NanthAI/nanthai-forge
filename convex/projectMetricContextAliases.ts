// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { streamQuery } from 'convex-helpers/server/pagination';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import schema from './schema';
import { invariant } from '../src/errors';
import {
  metricAliasGeneration,
  metricContextKey,
  metricContextKeys,
  metricContextRange,
  metricContextStreams,
  metricMemberKey,
  shiftedBillBoundary,
  type MetricContextLookup,
  type MetricContextStream,
} from '../src/self-metrics-context';
import type { MetricLiveRow } from './projectMetricContextSources';

export type MetricIndexKey = (string | number)[];
export type MetricJoinCursor = { member: MetricIndexKey; root: MetricIndexKey | null };
type Related = Extract<MetricContextLookup, { kind: 'intent' | 'lane' | 'failed-input' }>;
const index = 'by_project_and_key_and_source_time_and_id';

function comparePrefix(key: MetricIndexKey, bound: MetricIndexKey) {
  for (const [index, right] of bound.entries()) {
    const left = key[index]!;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export function validateMetricCursor(
  key: MetricIndexKey | null,
  start: MetricIndexKey,
  end: MetricIndexKey,
  inclusive = false,
) {
  invariant(
    key === null ||
      (Array.isArray(key) &&
        key.length >= start.length &&
        key.length <= 7 &&
        key.every(value => typeof value === 'string' || Number.isFinite(value)) &&
        comparePrefix(key, start) >= 0 &&
        comparePrefix(key, end) < (inclusive ? 1 : 0)),
    'EVIDENCE_CHANGED',
    'Continue the original metric context selection.',
  );
}

export function isRelatedMetricContext(lookup: MetricContextLookup): lookup is Related {
  return lookup.kind === 'intent' || lookup.kind === 'lane' || lookup.kind === 'failed-input';
}

export function metricContextAliases(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  context: number,
  from: number,
  to: number,
  budget: {
    full: () => boolean;
    count: (row: unknown) => void;
    emit: (row: MetricLiveRow) => void;
    resolve: (
      stream: MetricContextStream,
      id: string,
      count: (row: unknown) => void,
    ) => Promise<MetricLiveRow | null>;
  },
) {
  const rows = (start: MetricIndexKey, end: MetricIndexKey, key: MetricIndexKey | null, resume = false) => {
    validateMetricCursor(key, start, end);
    return streamQuery(ctx, {
      schema,
      table: 'projectMetricFacts',
      index,
      startIndexKey: key ?? start,
      startInclusive: key === null || resume,
      endIndexKey: end,
      endInclusive: false,
      order: 'asc',
    });
  };
  async function select(lookup: MetricContextLookup, key: MetricIndexKey | null) {
    const boundary =
      lookup.kind === 'bill-runs-shifted' ? shiftedBillBoundary(lookup.day, context, from) : null;
    if (boundary && !key) {
      const marker = await ctx.db
        .query('projectMetricFacts')
        .withIndex(index, q =>
          q.eq('projectId', projectId).eq('key', metricContextKey(metricAliasGeneration, boundary.marker)),
        )
        .first();
      if (!marker) return null;
      budget.count(marker);
    }
    const bounds = boundary ?? metricContextRange(lookup, context, from, to);
    if (comparePrefix(bounds.start as MetricIndexKey, bounds.end as MetricIndexKey) >= 0) return null;
    const edge = ([key, time]: readonly [string, number?]) => [
      projectId,
      metricContextKey(metricAliasGeneration, key),
      ...(time === undefined ? [] : [time]),
    ];
    const endTime = lookup.kind === 'root' || lookup.kind === 'passed-key' || boundary ? from : to;
    for await (const [alias, indexKey] of rows(edge(bounds.start), edge(bounds.end), key)) {
      budget.count(alias);
      const stream = metricContextStreams.find(stream => stream === alias.value);
      // Run aliases are written against the original creation timestamp. In
      // a partial creation-day bill range, rejected hits need no point read.
      if (
        stream &&
        (stream !== 'runs' || (alias.sourceCreatedAt >= context && alias.sourceCreatedAt < endTime))
      ) {
        const row = await budget.resolve(stream, alias.sourceId, budget.count);
        if (
          row &&
          row.sourceCreatedAt >= context &&
          row.sourceCreatedAt < endTime &&
          (!('stream' in lookup) || lookup.stream === stream) &&
          (!boundary ||
            (lookup.kind === 'bill-runs-shifted' &&
              row.stream === 'runs' &&
              row.row.started &&
              Date.parse(row.row.at) >= lookup.from &&
              Date.parse(row.row.at) < lookup.to)) &&
          [...metricContextKeys(row)].some(key => metricContextKey(metricAliasGeneration, key) === alias.key)
        ) {
          budget.emit(row);
        }
      }
      if (budget.full()) return indexKey as MetricIndexKey;
    }
    return null;
  }
  const visited = new Set<string>();
  async function join(lookup: Related, cursor: MetricJoinCursor | null) {
    const failed = lookup.kind === 'failed-input';
    const key = failed
      ? metricMemberKey(lookup.kind, lookup.intentId, lookup.head)
      : metricMemberKey(lookup.kind, lookup.id);
    const stream = failed ? 'runs' : 'attempts';
    invariant(
      cursor === null ||
        (Array.isArray(cursor?.member) && cursor.member.length === 4 && typeof cursor.member[3] === 'string'),
      'EVIDENCE_CHANGED',
      'Continue the original metric input selection.',
    );
    // The canonical input resolver uses this same Lane version horizon;
    // a pin outside it cannot classify a run or attempt by Lane or Intent.
    // One root can be staged by several operations. Seek past identical
    // membership keys without scanning their retained copies.
    membership: while (!budget.full()) {
      for await (const [member] of rows(
        [projectId, key, context],
        [projectId, key, from],
        cursor?.member ?? null,
        cursor?.root != null,
      )) {
        budget.count(member);
        const resume = cursor?.root ?? null;
        if (!resume && cursor?.member[2] === member.sourceCreatedAt && cursor.member[3] === member.sourceId)
          continue membership;
        cursor = { member: [projectId, key, member.sourceCreatedAt, member.sourceId], root: null };
        const visit = stream + ':' + member.sourceId;
        if (resume || !visited.has(visit)) {
          visited.add(visit);
          cursor.root = await select({ kind: 'root', stream, id: member.sourceId }, resume);
        }
        if (budget.full()) return cursor;
      }
      return null;
    }
    return cursor;
  }
  return { select, join };
}
