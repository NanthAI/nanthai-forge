// SPDX-License-Identifier: Apache-2.0
import type { MetricObservation } from './self-metrics-observations.js';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { readWorkFile, recordManifest, readRecordPage } from './work-records.js';
import { readSelfMetricJournal } from './self-metrics-journal.js';
import { NativeSource, nativeOwner } from './native-source.js';
import type { WorkData, WorkView } from './work-types.js';
import {
  minutesBetween,
  type MetricInput,
  type MetricRecords,
  type SelfMetricsReader,
} from './self-metrics-types.js';

/** Deliberately does not instantiate WorkStore: its constructor wakes owner workers. */
export function nativeSelfMetricsReader(
  owner: string,
  options: {
    data?: Partial<WorkData>;
    pointer?: Buffer | null;
    fast?: boolean;
    journal?: ReturnType<typeof readSelfMetricJournal>;
  } = {},
): SelfMetricsReader {
  return {
    read() {
      owner = nativeOwner(realpathSync(owner)) ?? realpathSync(owner);
      const directory = join(owner, '.forge', 'work');
      const bytes = options.data ? null : (options.pointer ?? readWorkFile(directory));
      if (!bytes && !options.data) throw new Error('Owner Work records are unavailable.');
      const raw = (options.data ?? JSON.parse(bytes!.toString('utf8'))) as Record<string, unknown>;
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
        moves = read('channelMoves'),
        githubChecks = read('githubChecks') ?? [],
        githubSync = (manifest?.fields.githubSync ?? raw.githubSync) as WorkData['githubSync'];
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
      const { receipts, incompleteTrailingRecords } = options.journal ?? readSelfMetricJournal(directory);
      const supplemental: MetricObservation[] = receipts.flatMap(r =>
        r.kind === 'mutation' && r.revision !== undefined
          ? [
              {
                type: 'revision' as const,
                id: `owner:${r.revision}`,
                at: r.at,
                mode: 'owner-hosted' as const,
                stream: 'owner',
                side: 'authority' as const,
                revision: r.revision,
              },
            ]
          : [],
      );
      for (const snapshot of githubChecks)
        for (const check of snapshot.checks) {
          const mapped = githubSync?.commits.find(commit => commit.commit === check.head_sha);
          if (
            mapped &&
            /^verify$/i.test(check.name) &&
            check.completed_at &&
            ['success', 'failure'].includes(check.conclusion ?? '')
          )
            supplemental.push({
              type: 'full-result',
              id: `github-verify:${check.id}`,
              at: check.completed_at,
              head: mapped.state,
              source: 'github-verify',
              status: check.conclusion === 'success' ? 'passed' : 'failed',
            });
        }
      const source = new NativeSource(owner);
      const culpritIds = new Set(moves.flatMap(move => move.optimisticRecovery?.culpritIds ?? []));
      const culpritHeads = moves.filter(move => culpritIds.has(move.id)).map(move => move.head);
      for (const id of culpritIds) {
        const move = moves.find(move => move.id === id);
        if (!move) continue;
        supplemental.push({ type: 'culprit', id: `culprit:${id}`, landingId: id, at: move.at });
      }
      const coverage = {
        overlaps: receipts.find(r => r.observation?.type === 'save')?.at,
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
        observations: supplemental,
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
            ancestorHeads: culpritHeads.filter(head => {
              try {
                return !options.fast && source.contains(move.head, head);
              } catch {
                return false;
              }
            }),
            inputs: inputs(viewMap.get(move.viewId)),
            kind: viewMap.get(move.viewId)?.recovery?.phase === 'revert' ? 'revert' : 'landing',
          })),
        submissions: entries.flatMap(entry => {
          const batch = batches.find(b => b.id === entry.batchId);
          const entryInputs = inputs(viewMap.get(entry.viewId));
          return entryInputs.map(input => ({
            id: `${entry.id}:${input.laneId}`,
            entryId: entry.id,
            retryCause:
              entry.status === 'conflict'
                ? ('conflict' as const)
                : entry.status === 'cancelled'
                  ? ('cancelled' as const)
                  : entry.stall
                    ? ('stall' as const)
                    : entry.status === 'failed' && !entry.error
                      ? ('check-failure-or-flake' as const)
                      : ('other' as const),
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
            head: run.head,
            fullSuite:
              run.checkSelection?.scope === 'full' || (run.mainCheck?.channel === 'main' && !run.recovery),
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
            reuseKey: run.reuseKey,
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
