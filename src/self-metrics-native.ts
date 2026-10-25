// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { readWorkFile, recordManifest, readRecordPage } from './work-records.js';
import { NativeSource } from './native-source.js';
import { digest } from './hash.js';
import { selfMetricReuseKey } from './self-metrics-reuse-key.js';
import { readSelfMetricJournal } from './self-metrics-journal.js';
import type { WorkData, CheckRun, WorkView } from './work-types.js';
import {
  minutesBetween,
  type MetricInput,
  type MetricRecords,
  type SelfMetricsReader,
} from './self-metrics-types.js';

/** Deliberately does not instantiate WorkStore: its constructor wakes owner workers. */
export function nativeSelfMetricsReader(owner: string): SelfMetricsReader {
  return {
    read() {
      owner = realpathSync(owner);
      const directory = join(owner, '.forge', 'work');
      const bytes = readWorkFile(directory);
      if (!bytes) throw new Error('Owner Work records are unavailable.');
      const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      const manifest = recordManifest(raw);
      const read = <K extends keyof WorkData>(name: K): WorkData[K] => {
        if (!manifest) return (raw[name] ?? []) as WorkData[K];
        if (!manifest.collections[name]) return [] as unknown as WorkData[K];
        return readRecordPage(directory, manifest, name, 0, manifest.collections[name]!.count || 1)
          .records as WorkData[K];
      };
      const lanes = read('lanes'),
        views = read('views'),
        entries = (read('landingEntries') ?? []).filter(entry => entry.channel === 'main'),
        batches = read('landingBatches') ?? [],
        runs = read('runs'),
        moves = read('channelMoves');
      // Automation definitions and friction prose cannot establish commands, errors or timings.
      // Read these collections to retain only structured evidence; never mine their text.
      const automations = read('automations'),
        friction = read('frictionEvents') ?? [];
      const laneMap = new Map(lanes.map(lane => [lane.id, lane]));
      const viewMap = new Map(views.map(view => [view.id, view]));
      const inputs = (view: Pick<WorkView, 'inputs'> | undefined): MetricInput[] =>
        (view?.inputs ?? []).flatMap(input => {
          const lane = laneMap.get(input.laneId);
          if (!lane) return [];
          const save = lane.checkpoints.find(save => save.head === input.head);
          return [{ ...input, intentId: lane.intentId, ...(save ? { savedAt: save.at } : {}) }];
        });
      const source = new NativeSource(owner);
      const keys = new Map<string, { tree: string; lockfile?: string | undefined } | undefined>();
      const reuseKey = (run: CheckRun) => {
        if (!keys.has(run.head)) {
          try {
            const files = source.state(run.head).files;
            keys.set(run.head, {
              tree: digest(JSON.stringify(files)),
              lockfile: files.find(f => f.path === 'package-lock.json')?.blob,
            });
          } catch {
            keys.set(run.head, undefined);
          }
        }
        const sourceKey = keys.get(run.head);
        const observations = run.inputObservations;
        const declared = run.check.declaredInputs ?? [];
        const complete =
          !declared.length ||
          (observations?.length === declared.length &&
            observations.every(o => o.status === 'observed' && o.sha256));
        return selfMetricReuseKey({
          tree: sourceKey?.tree,
          definition: run.check.definition,
          lockfile: sourceKey?.lockfile ?? run.backend?.lockfile,
          node: run.environment.node,
          declaredInputs: complete
            ? declared.map((input, index) => ({ input, sha256: observations?.[index]?.sha256 }))
            : undefined,
        });
      };
      const { receipts, incompleteTrailingRecords } = readSelfMetricJournal(directory);
      const coverage = {
        lifecycle: receipts.find(r => r.kind === 'lifecycle')?.at,
        mutations: receipts.find(r => r.kind === 'mutation')?.at,
        deliveries: receipts.find(r => r.kind === 'lifecycle')?.at,
        checkRequests: receipts.find(r => r.kind === 'lifecycle')?.at,
      };
      const records: MetricRecords = {
        source: {
          kind: 'native',
          revision: manifest?.fields.revision as number | undefined,
          collections: {
            channelMoves: moves.length,
            landingEntries: entries.length,
            landingBatches: batches.length,
            runs: runs.length,
            automations: automations.length,
            frictionEvents: friction.length,
          },
        },
        landingKindsComplete: false,
        lifecycleCoverageGaps: [
          'Argument-validation and incompatible-store refusals have no local lifecycle receipt.',
        ],
        mutationCoverageGaps: ['Manual owner-service restarts outside Forge have no requester record.'],
        moves: moves
          .filter(move => move.channel === 'main' && move.status === 'accepted')
          .map(move => ({
            id: move.id,
            at: move.at,
            head: move.head,
            inputs: inputs(viewMap.get(move.viewId)),
            kind: viewMap.get(move.viewId)?.recovery?.phase === 'revert' ? 'revert' : 'landing',
          })),
        submissions: entries.flatMap(entry => {
          const batch = batches.find(b => b.id === entry.batchId);
          const entryInputs = inputs(viewMap.get(entry.viewId));
          return entryInputs.map(input => ({
            id: `${entry.id}:${input.laneId}`,
            entryId: entry.id,
            at: entry.arrivedAt,
            inputs: [input],
            status:
              entry.status === 'cancelled' &&
              runs.find(r => r.id === entry.runId)?.cancellation?.reason === 'superseded'
                ? 'superseded'
                : entry.status,
            endedAt: entry.terminalAt ?? runs.find(r => r.id === entry.runId)?.endedAt,
            progressAt: [entry.firstSelectedAt, batch?.arrivedAt].filter((at): at is string => !!at),
            runIds: [
              ...new Set(
                [
                  entry.runId,
                  ...(batch?.prefixes ?? []).filter(p => p.entryIds.includes(entry.id)).map(p => p.runId),
                  ...(batch?.diagnosis?.nodes ?? [])
                    .filter(n => n.entryIds.includes(entry.id))
                    .map(n => n.runId),
                ].filter((id): id is string => !!id),
              ),
            ],
          }));
        }),
        runs: runs.map(run => {
          const usage = run.backend?.costUsage?.filter(item => item.basis === 'worker-runtime');
          const items = usage?.length
            ? usage.map(item => ({
                id: `${run.backend!.actual}:${item.executionId}`,
                minutes: item.seconds / 60,
              }))
            : run.backend?.actual === 'github-actions'
              ? run.backend.cost?.items.flatMap(item =>
                  item.executingSeconds === undefined || item.executingSeconds === null
                    ? []
                    : [{ id: `github-actions:${item.id}`, minutes: item.executingSeconds / 60 }],
                )
              : undefined;
          const wall = minutesBetween(run.startedAt, run.endedAt);
          return {
            id: run.id,
            at: run.startedAt,
            ...(run.endedAt ? { endedAt: run.endedAt } : {}),
            status: run.status,
            inputs: inputs(run),
            wallMinutes: wall,
            started:
              !!run.childPid ||
              run.status === 'running' ||
              (run.exitCode !== undefined && run.exitCode !== null) ||
              !!items?.length,
            runnerMinutes:
              run.resourceUsage?.status === 'measured' ? run.resourceUsage.realSeconds / 60 : undefined,
            ...(items?.length ? { executions: items } : {}),
            ...(run.reusedFrom ? { reusedFrom: run.reusedFrom.runId } : {}),
            reuseKey: reuseKey(run),
          };
        }),
        receipts,
        incompleteReceiptRecords: incompleteTrailingRecords,
        coverage,
        gaps: [
          'Legacy records do not identify revert/compensating landings uniformly; only structured recovery.phase=revert is separated.',
          'No-owner cause tags and manual service/queue mutations require structured requester records; friction prose is not evidence.',
        ],
      };
      records.checkRequests = receipts.flatMap(receipt =>
        (receipt.checkRequests ?? []).map(r => ({
          ...r,
          at: receipt.at,
          reuseKey: records.runs.find(run => run.id === r.runId)?.reuseKey,
        })),
      );
      return records;
    },
  };
}
