// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from './hosted-source-operation.js';

export const metricContextStreams = ['requests', 'attempts', 'runs'] as const;
export type MetricContextStream = (typeof metricContextStreams)[number];

export type MetricContextLookup =
  | { kind: 'created'; stream: MetricContextStream }
  | { kind: 'activity'; stream: MetricContextStream }
  | { kind: 'bill-runs'; from: number; to: number }
  | { kind: 'bill-runs-shifted'; day: number; from: number; to: number }
  | { kind: 'full-runs' }
  | { kind: 'entry'; id: string }
  | { kind: 'entry-retry'; id: string }
  | { kind: 'attempt-run'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'intent'; id: string }
  | { kind: 'lane'; id: string }
  | { kind: 'root'; stream: 'attempts' | 'runs'; id: string }
  | { kind: 'failed-input'; intentId: string; head: string }
  | { kind: 'passed-key'; reuseKey: string };

export type MetricContextRow = {
  stream: MetricContextStream;
  sourceCreatedAt: number;
  sourceId: string;
  row: unknown;
};

export const metricContextKey = (generation: string, key: string) =>
  'metric-context-v1:' + canonicalPayload(generation) + ':' + key;
export const metricAliasGeneration = 'aliases-1';
const key = (...parts: string[]) => canonicalPayload(parts);
export const metricMemberKey = (kind: 'intent' | 'lane' | 'failed-input', ...identity: string[]) =>
  metricContextKey(metricAliasGeneration, key('member', kind, ...identity));
// Allow timestamp assignment just before or after the commit. Restored/imported
// runs can have a larger offset and use the separate creation-bounded selection.
export const metricTimeSlopMs = 60_000;
const dayMs = 86_400_000;
const shiftedBillFamily = (day: number) => `bill-runs-shifted:${day}`;
const shiftedBillKeys = (day: number) => ({
  creation: key('shifted-creation', String(day)),
  marker: key('shifted-marker', String(day)),
});

/** A partial UTC day uses the creation-time index. Whole days can select by
 * event time directly. The marker replaces the otherwise empty range read. */
export function shiftedBillBoundary(day: number, context: number, reportFrom: number) {
  const from = day * dayMs;
  const to = from + dayMs;
  if (context <= from && reportFrom >= to) return null;
  const { marker, creation } = shiftedBillKeys(day);
  return {
    marker,
    start: [creation, Math.max(context, from)] as const,
    end: [creation, Math.min(reportFrom, to)] as const,
  };
}

/** In-window creations already seed the report. For restored starts select
 * only the UTC creation days intersecting the bounded pre-window horizon. */
export function shiftedBillLookups(context: number, reportFrom: number, from: number, to: number) {
  const lookups: MetricContextLookup[] = [];
  for (let day = Math.floor(context / dayMs); day * dayMs < reportFrom && context < reportFrom; day++)
    lookups.push({ kind: 'bill-runs-shifted', day, from, to });
  return lookups;
}

function timeKey(family: string, at: number) {
  // Date.parse returns integral milliseconds. Both inclusive lower and
  // exclusive upper bounds round up to preserve the same set of event times.
  at = Math.ceil(at);
  const beforeEpoch = at < 0;
  const magnitude = beforeEpoch ? 8_640_000_000_000_000 + at : at;
  return family + ':' + (beforeEpoch ? '0' : '1') + String(magnitude).padStart(16, '0');
}

/** Index order is key, canonical creation time, then the original row ID. Time
 * selectors carry a separate event time in the key, never in the creation field. */
export function metricContextRange(
  lookup: MetricContextLookup,
  context: number,
  from: number,
  to: number,
): { start: [string, number?]; end: [string, number?]; rows: boolean } {
  const exact = (selected: string, lower = context, upper = to, rows = false) => ({
    start: [selected, lower] as [string, number],
    end: [selected, upper] as [string, number],
    rows,
  });
  const time = (family: string, lower: number, upper: number) => ({
    start: [timeKey(family, lower)] as [string],
    end: [timeKey(family, upper)] as [string],
    rows: false,
  });
  switch (lookup.kind) {
    case 'created':
      return exact(key('row', lookup.stream), from, to, true);
    case 'activity':
      return time(lookup.stream + '-activity', from, to);
    case 'bill-runs':
      return time(
        'runs-started',
        Math.max(lookup.from, context - metricTimeSlopMs),
        Math.min(lookup.to, from + metricTimeSlopMs),
      );
    case 'bill-runs-shifted':
      return time(shiftedBillFamily(lookup.day), lookup.from, lookup.to);
    case 'full-runs':
      // Equality with the report end is included in the report source count.
      return exact(key('full'));
    case 'entry':
      return exact(key('entry', lookup.id));
    case 'entry-retry':
      return exact(key('entry-retry', lookup.id), context - metricTimeSlopMs, to + metricTimeSlopMs);
    case 'root':
      return exact(
        key('root', lookup.stream, lookup.id),
        context - metricTimeSlopMs,
        from + metricTimeSlopMs,
      );
    case 'attempt-run':
      return exact(key('attempt-run', lookup.id), context - metricTimeSlopMs, to + metricTimeSlopMs);
    case 'run':
      return exact(key('run', lookup.id));
    case 'intent':
      return exact(key('intent', lookup.id), context, from);
    case 'lane':
      return exact(key('lane', lookup.id), context, from);
    case 'failed-input':
      return exact(key('failed-input', lookup.intentId, lookup.head), context, from);
    case 'passed-key':
      return exact(key('passed-key', lookup.reuseKey), context, from);
  }
}

type ProjectableMetricContextRow = Pick<MetricContextRow, 'stream' | 'sourceCreatedAt'> & {
  row: {
    id: string;
    at: string;
    endedAt?: string | null;
    submissionId?: string;
    started?: boolean;
    status?: string;
    fullSuite?: boolean | null;
    reuseKey?: string | null;
    runId?: string | null;
    runIds?: string[];
    admissionRun?: { runId: string } | null;
    sharedBatch?: { runId: string } | null;
    retry?: { supersedes: string };
    inputPin?: { sha256: string } | null;
  };
};

/** The same key derivation selects new aliases and rechecks live hits. */
export function metricContextKeys({ stream, sourceCreatedAt, row }: ProjectableMetricContextRow) {
  const lookups = new Set<string>();
  const at = Date.parse(row.at);
  const end = row.endedAt ? Date.parse(row.endedAt) : NaN;
  for (const time of [at, end]) if (time > sourceCreatedAt) lookups.add(timeKey(stream + '-activity', time));
  if (stream === 'runs') {
    if (row.started) {
      if (Math.abs(at - sourceCreatedAt) <= metricTimeSlopMs) lookups.add(timeKey('runs-started', at));
      else {
        const day = Math.floor(sourceCreatedAt / dayMs);
        const { creation, marker } = shiftedBillKeys(day);
        lookups.add(timeKey(shiftedBillFamily(day), at));
        lookups.add(creation);
        // Per-run witnesses let readers test one day without querying or
        // updating a shared marker on the landing path.
        lookups.add(marker);
      }
    }
    if (row.fullSuite && row.endedAt) lookups.add(key('full'));
    if (row.endedAt && row.reuseKey && row.status === 'passed') lookups.add(key('passed-key', row.reuseKey));
    if (row.inputPin && row.endedAt && (row.status === 'failed' || row.status === 'interrupted'))
      lookups.add(key('root', stream, row.inputPin.sha256));
  } else {
    if (row.retry) lookups.add(key('entry-retry', row.retry.supersedes));
    for (const id of [row.runId, row.admissionRun?.runId, row.sharedBatch?.runId, ...(row.runIds ?? [])])
      if (id) lookups.add(key('attempt-run', id));
    if (stream === 'attempts' && row.inputPin) lookups.add(key('root', stream, row.inputPin.sha256));
  }
  return lookups;
}
