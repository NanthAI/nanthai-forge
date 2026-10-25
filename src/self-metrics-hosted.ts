// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import type { HostedRecord } from './hosted-records.js';
import type { HostedAcceptance } from './hosted-acceptance.js';
import type { HostedLandingAttempt, HostedLandingState } from './hosted-landing.js';
import type { HostedCheckRun } from './hosted-check.js';
import type { SelfMetricReceipt } from './self-metrics-journal.js';
import { selfMetricReuseKey } from './self-metrics-reuse-key.js';
import {
  minutesBetween,
  type MetricInput,
  type MetricRecords,
  type SelfMetricsReader,
} from './self-metrics-types.js';
import { composePageSchema } from './hosted-compose.js';
import { invariant } from './errors.js';

type Pin = { sha256: string; size: number };
/** Supply authenticated, revision-pinned pages from hosted exports/queries. No writes. */
export interface HostedMetricSource {
  records(table: string): Promise<unknown[]>;
  object?(pin: Pin): Promise<Uint8Array | undefined>;
  receipts?: SelfMetricReceipt[];
  observations?: MetricRecords['observations'];
  incompleteReceiptRecords?: number;
  coverage?: MetricRecords['coverage'];
  revision?: number | string;
}
function value<T>(row: unknown): T {
  const wrapped = row as { value?: string };
  return (typeof wrapped?.value === 'string' ? JSON.parse(wrapped.value) : row) as T;
}
export function hostedSelfMetricsReader(source: HostedMetricSource): SelfMetricsReader {
  return {
    async read() {
      const tables = [
        'projectHostedRecords',
        'projectHostedLandingRequests',
        'projectHostedLandingAttempts',
        'projectHostedAcceptances',
        'projectHostedCheckRuns',
        'projectHostedRecordBodies',
      ];
      const [rawRecords, rawRequests, rawAttempts, rawMoves, rawRuns, rawBodies] = await Promise.all(
        tables.map(table => source.records(table)),
      );
      const bodies = new Map(
        (rawBodies ?? []).map(row => [(row as { _id: string })._id, value<HostedRecord>(row)]),
      );
      const records = rawRecords!.map(row => {
        const bodyId = (row as { bodyId?: string }).bodyId;
        const record = bodyId ? bodies.get(bodyId) : value<HostedRecord>(row);
        invariant(record && 'id' in record, 'EVIDENCE_CHANGED', 'Hosted metric record body is unavailable.');
        return record;
      });
      const lanes = records.filter(r => r.kind === 'lane');
      const saves = records.filter(r => r.kind === 'save');
      const requests = rawRequests!.map(value<HostedLandingState>);
      const attempts = rawAttempts!.map(value<HostedLandingAttempt>);
      const moves = rawMoves!.map(value<HostedAcceptance>);
      const runs = rawRuns!.map(value<HostedCheckRun>);
      const gaps = new Set<string>();
      const json = async (pin: Pin) => {
        const bytes = await source.object?.(pin);
        if (!bytes) return;
        invariant(
          bytes.length === pin.size && digest(bytes) === pin.sha256,
          'EVIDENCE_CHANGED',
          'Hosted metric object differs from its pin.',
        );
        return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      };
      const inputCache = new Map<string, MetricInput[]>();
      const inputs = async (pin: Pin): Promise<MetricInput[]> => {
        const cached = inputCache.get(pin.sha256);
        if (cached) return cached;
        const result: MetricInput[] = [];
        const seen = new Set<string>();
        let next: Pin | null = pin;
        while (next) {
          invariant(!seen.has(next.sha256), 'EVIDENCE_CHANGED', 'Hosted input page chain contains a cycle.');
          seen.add(next.sha256);
          const raw = await json(next);
          if (!raw) {
            gaps.add('Hosted Candidate input pages unavailable.');
            break;
          }
          const page = composePageSchema.parse(raw);
          for (const entry of page.entries)
            if ('laneId' in entry) {
              const lane = lanes.filter(l => l.id === entry.laneId).sort((a, b) => b.version - a.version)[0];
              if (!lane) {
                gaps.add('Hosted Lane-to-Intent record unavailable.');
                continue;
              }
              const save = saves
                .filter(s => s.laneId === lane.id && s.head === entry.head)
                .sort((a, b) => a.at.localeCompare(b.at))[0];
              result.push({
                laneId: lane.id,
                intentId: lane.intentId,
                head: entry.head,
                ...(save ? { savedAt: save.at } : {}),
                ...(lanes.some(l => l.id === entry.laneId && l.version === entry.version && l.revert)
                  ? { compensating: true }
                  : {}),
              });
            }
          next = page.next;
        }
        inputCache.set(pin.sha256, result);
        return result;
      };
      const metricRuns = await Promise.all(
        runs.map(async run => {
          return {
            id: run.id,
            at: run.at,
            ...(run.endedAt ? { endedAt: run.endedAt } : {}),
            status: run.status,
            started: !!run.executionId,
            inputs: await inputs(run.candidate.inputs),
            wallMinutes: minutesBetween(run.at, run.endedAt ?? undefined),
            runnerMinutes:
              run.cost.status === 'observed' && run.cost.seconds !== null ? run.cost.seconds / 60 : undefined,
            reuseKey: selfMetricReuseKey({
              tree: undefined,
              definition: run.check.definition,
              lockfile: run.plan?.lockfile,
              node: undefined,
              declaredInputs: run.check.declaredInputs?.length ? undefined : [],
            }),
          };
        }),
      );
      return {
        source: { kind: 'hosted', revision: source.revision },
        ...(source.observations ? { observations: source.observations } : {}),
        landingKindsComplete: false,
        moves: await Promise.all(
          moves
            .filter(m => m.channel === 'main')
            .map(async move => {
              const selected = await inputs(move.candidate.inputs);
              return {
                id: move.id,
                at: move.at,
                head: move.candidate.head,
                inputs: selected,
                kind: selected.some(input => input.compensating)
                  ? ('compensating' as const)
                  : ('landing' as const),
              };
            }),
        ),
        submissions: (
          await Promise.all(
            attempts.map(async attempt => {
              const request = requests.find(r => r.id === attempt.submissionId);
              const current = request?.attemptId === attempt.id;
              const run = runs.find(r => r.id === attempt.check?.runId);
              const status = !current
                ? 'superseded'
                : request?.phase === 'terminal-failed'
                  ? 'failed'
                  : (request?.phase ?? 'unknown');
              const endedAt = !current
                ? attempts.find(a => a.parentAttemptId === attempt.id)?.at
                : (run?.endedAt ?? undefined);
              return (await inputs(attempt.candidate.inputs)).map(input => ({
                id: `${attempt.id}:${input.laneId}`,
                entryId: attempt.submissionId,
                at: attempt.at,
                inputs: [input],
                status,
                endedAt,
                progressAt: [],
                runIds: attempt.check ? [attempt.check.runId] : [],
              }));
            }),
          )
        ).flat(),
        runs: metricRuns,
        receipts: source.receipts ?? [],
        lifecycleCoverageGaps: ['Argument-validation refusals have no local lifecycle receipt.'],
        incompleteReceiptRecords: source.incompleteReceiptRecords ?? 0,
        ...(source.coverage ? { coverage: source.coverage } : {}),
        gaps: [
          ...gaps,
          'Hosted records lack Node major.minor and complete declared-input observations; reuse keys remain unknown.',
          'Hosted terminal states are persisted outcomes, not evidence of delivery to a requester.',
        ],
      };
    },
  };
}
