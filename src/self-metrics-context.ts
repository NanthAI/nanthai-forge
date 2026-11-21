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
const key = (...parts: string[]) => canonicalPayload(parts);
const rowKey = (kind: MetricContextStream) => key('row', kind);
// Allow timestamp assignment just before or after the commit. Restored/imported
// runs can have a larger offset and use the separate creation-bounded selection.
const runStartSlopMs = 60_000;
const dayMs = 86_400_000;
const shiftedBillFamily = (day: number) => `bill-runs-shifted:${day}`;

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
      return exact(rowKey(lookup.stream), from, to, true);
    case 'activity':
      return time(lookup.stream + '-activity', from, to);
    case 'bill-runs':
      return time(
        'runs-started',
        Math.max(lookup.from, context - runStartSlopMs),
        Math.min(lookup.to, from + runStartSlopMs),
      );
    case 'bill-runs-shifted':
      return time(shiftedBillFamily(lookup.day), lookup.from, lookup.to);
    case 'full-runs':
      // Equality with the report end is included in the report source count.
      return exact(key('full'));
    case 'entry':
      return exact(key('entry', lookup.id));
    case 'entry-retry':
      return exact(key('entry-retry', lookup.id));
    case 'attempt-run':
      return exact(key('attempt-run', lookup.id));
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

type ProjectableMetricContextRow = Omit<MetricContextRow, 'row'> & {
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
  };
};

/** Associations store only the primary stream; creation time and original ID
 * address the primary row under the same index. Multiple inputs can name one key. */
export function metricContextFacts(
  generation: string,
  { stream, sourceCreatedAt, sourceId, row }: ProjectableMetricContextRow,
  inputs: readonly { laneId: string; intentId: string; head: string }[],
) {
  const primary = {
    key: metricContextKey(generation, rowKey(stream)),
    sourceCreatedAt,
    sourceId,
    value: canonicalPayload(row),
  };
  const lookups = new Set<string>();
  const at = Date.parse(row.at);
  const end = row.endedAt ? Date.parse(row.endedAt) : NaN;
  for (const time of [at, end]) if (time > sourceCreatedAt) lookups.add(timeKey(stream + '-activity', time));
  if (stream === 'runs') {
    lookups.add(key('run', row.id));
    if (row.started)
      lookups.add(
        timeKey(
          Math.abs(at - sourceCreatedAt) <= runStartSlopMs
            ? 'runs-started'
            : shiftedBillFamily(Math.floor(sourceCreatedAt / dayMs)),
          at,
        ),
      );
    if (row.fullSuite && row.endedAt) lookups.add(key('full'));
    if (row.endedAt && row.reuseKey && row.status === 'passed') lookups.add(key('passed-key', row.reuseKey));
    if (row.endedAt && (row.status === 'failed' || row.status === 'interrupted'))
      for (const input of inputs) lookups.add(key('failed-input', input.intentId, input.head));
  } else {
    lookups.add(key('entry', row.submissionId ?? row.id));
    if (row.retry) lookups.add(key('entry-retry', row.retry.supersedes));
    for (const id of [row.runId, row.admissionRun?.runId, row.sharedBatch?.runId, ...(row.runIds ?? [])])
      if (id) lookups.add(key('attempt-run', id));
    for (const input of inputs) {
      lookups.add(key('intent', input.intentId));
      lookups.add(key('lane', input.laneId));
    }
  }
  return [
    primary,
    ...[...lookups].map(key => ({
      key: metricContextKey(generation, key),
      sourceCreatedAt,
      sourceId,
      value: stream,
    })),
  ];
}
