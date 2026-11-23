// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { invariant } from './errors.js';
import {
  metricContextStreams,
  shiftedBillLookups,
  type MetricContextLookup,
  type MetricContextStream,
} from './self-metrics-context.js';
import type { MetricPin } from './self-metrics-hosted-inputs.js';
import { hostedActionError } from './hosted-action-error.js';
import type { MetricInput, MetricPeriod } from './self-metrics-types.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';

const contextPage = z.object({
  page: z
    .array(
      z.object({
        stream: z.enum(metricContextStreams),
        sourceCreatedAt: z.number(),
        sourceId: z.string(),
        row: z.unknown(),
      }),
    )
    .max(100),
  authority: sourceAuthoritySchema,
  cutover: z.iso.datetime().nullable(),
  isDone: z.boolean(),
  continueCursor: z.string(),
});

type ContextEvidence = {
  id: string;
  at: string;
  endedAt?: string | null | undefined;
  submissionId?: string;
  runId?: string | null;
  runIds?: string[];
  admissionRun?: { runId: string } | null | undefined;
  sharedBatch?: { runId: string } | null | undefined;
  inputPin?: MetricPin | null | undefined;
  reuseKey?: string | null | undefined;
};
type ContextRow = z.infer<typeof contextPage>['page'][number] & { row: ContextEvidence };

export async function readExactHostedContext(
  query: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  period: MetricPeriod,
  contextDays: number,
  generation: string,
  epoch: number,
  cutover: string | null,
  moves: () => Promise<ContextEvidence[]>,
  billPeriods: { from: number; to: number }[],
  parse: (kind: MetricContextStream, row: unknown) => ContextEvidence,
  resolveInputs: (pins: MetricPin[]) => Promise<Map<string, MetricInput[]>>,
) {
  const from = Date.parse(period.from),
    to = Date.parse(period.to);
  const during = (at: string) => Date.parse(at) >= from && Date.parse(at) < to;
  const selected = new Map<string, ContextRow>();
  const requested = new Set<string>();
  const load = async (lookups: MetricContextLookup[]) => {
    const fresh = lookups.filter(lookup => {
      const key = JSON.stringify(lookup);
      if (requested.has(key)) return false;
      requested.add(key);
      return true;
    });
    const readBatch = async (offset: number, order: Map<string, number>, stopped: () => boolean) => {
      const lookups = fresh.slice(offset, offset + 100);
      let cursor: string | null = null;
      const seen = new Set<string>();
      while (!stopped()) {
        const raw = await query('projectSelfMetrics:page', {
          stream: 'requests',
          from: period.from,
          to: period.to,
          contextDays,
          cursor,
          contextSelection: { generation, lookups },
        });
        const page = contextPage.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        invariant(
          page.authority.mode === 'server' && page.authority.epoch === epoch && page.cutover === cutover,
          'SOURCE_AUTHORITY_CHANGED',
          'Authority changed during metric history selection.',
        );
        for (const item of page.page) {
          const row = parse(item.stream, item.row);
          // Overlapping batches can find the same mutable source row. Keep
          // the result from the later batch, as in serial selection.
          if ((order.get(item.sourceId) ?? -1) > offset) continue;
          order.set(item.sourceId, offset);
          selected.set(item.sourceId, { ...item, row });
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
        invariant(cursor && !seen.has(cursor), 'EVIDENCE_CHANGED', 'Metric context cursor did not advance.');
        seen.add(cursor);
      }
    };
    for (let start = 0; start < fresh.length; start += 400) {
      const order = new Map<string, number>();
      const batches = [];
      let failed = false;
      for (let offset = start; offset < Math.min(start + 400, fresh.length); offset += 100)
        batches.push(
          readBatch(offset, order, () => failed).catch(error => {
            failed = true;
            throw error;
          }),
        );
      const outcomes = await Promise.allSettled(batches);
      const errors = outcomes.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
      // In-flight pages still validate their authority. Do not downgrade
      // such a failure just because another batch invalidated its cursor.
      if (errors.length) {
        const priority = errors.find(
          error =>
            !['EVIDENCE_CHANGED', 'HOSTED_ACTION_FAILED', 'HOSTED_REQUEST_FAILED'].includes(
              hostedActionError(error, 'metrics').code,
            ),
        );
        throw priority ?? errors[0];
      }
    }
  };
  await load([
    ...metricContextStreams.flatMap(stream => [
      { kind: 'created', stream } as const,
      { kind: 'activity', stream } as const,
    ]),
    { kind: 'full-runs' },
    ...billPeriods.flatMap(({ from: billFrom, to: billTo }) => [
      { kind: 'bill-runs' as const, from: billFrom, to: billTo },
      ...shiftedBillLookups(from - contextDays * 86_400_000, from, billFrom, billTo),
    ]),
  ]);
  const periodMoves = (await moves()).filter(move => during(move.at));

  const rows = (stream: MetricContextStream) =>
    [...selected.values()].filter(item => item.stream === stream).map(item => item.row);
  const entries = () => [...rows('attempts'), ...rows('requests')].map(row => row.submissionId ?? row.id);
  const entryLookups = (ids: string[]) => ids.map(id => ({ kind: 'entry' as const, id }));
  const pins = (rows: ContextEvidence[]) => rows.flatMap(row => (row.inputPin ? [row.inputPin] : []));
  await load([
    ...entryLookups([...entries(), ...periodMoves.map(move => move.submissionId!)]),
    ...rows('runs')
      .filter(run => during(run.at) || (run.endedAt && during(run.endedAt)))
      .map(run => ({ kind: 'attempt-run' as const, id: run.id })),
  ]);
  // An old attempt selected through its run can point to an old request or a
  // sibling that must take part in the same attempt/entry join.
  await load(entryLookups(entries()));

  const movePins = pins(periodMoves);
  const entryPins = pins(rows('attempts'));
  const inputs = await resolveInputs([...movePins, ...entryPins]);
  const movesInputs = movePins.flatMap(pin => inputs.get(pin.sha256) ?? []);
  await load([
    ...[...inputs.values()].flatMap(items =>
      items.flatMap(input => [
        { kind: 'intent' as const, id: input.intentId },
        { kind: 'lane' as const, id: input.laneId },
      ]),
    ),
    ...movesInputs.map(({ intentId, head }) => ({ kind: 'failed-input' as const, intentId, head })),
    ...rows('runs').flatMap(run =>
      during(run.at) && run.reuseKey ? [{ kind: 'passed-key' as const, reuseKey: run.reuseKey }] : [],
    ),
  ]);
  await load([...entryLookups(entries()), ...entries().map(id => ({ kind: 'entry-retry' as const, id }))]);

  // Admission and attempt evidence can name earlier runs independently of
  // the run's input, requested head or creation window.
  await load([
    ...entryLookups(entries()),
    ...[...rows('attempts'), ...rows('requests')].flatMap(row =>
      [row.runId, ...(row.runIds ?? []), row.admissionRun?.runId, row.sharedBatch?.runId].flatMap(id =>
        id ? [{ kind: 'run' as const, id }] : [],
      ),
    ),
  ]);
  const ordered = [...selected.values()].sort(
    (a, b) => b.sourceCreatedAt - a.sourceCreatedAt || (a.sourceId < b.sourceId ? 1 : -1),
  );
  return Object.fromEntries(
    metricContextStreams.map(stream => [
      stream,
      ordered.filter(item => item.stream === stream).map(item => item.row),
    ]),
  ) as Record<MetricContextStream, ContextEvidence[]>;
}
