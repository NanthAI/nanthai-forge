import { runLogRecord } from './check-log-policy.js';
import { statusMetrics } from './self-metrics-status.js';
import { readSelfMetricDisk } from './self-metrics-disk.js';
import { integrationPreviewStatus } from './integration-preview-auto.js';
import { readLandingWorkerStatus } from './landing-worker-status.js';
// SPDX-License-Identifier: Apache-2.0
import { readLaneSubmissions } from './landing-submission-read.js';
import { savedOverlapPlan } from './agent-overlap-plan.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { waitingFinishes } from './agent-finish-journal.js';
import { readHostState } from './host-binding.js';
import { readAutoExchangeStatus } from './auto-exchange-status.js';
import { pendingStatus, type RecoveryCaptureObservation } from './pending-status.js';
import type { Lane } from './work-types.js';
import type { WorkStore } from './work-store.js';
import type { WorkCollection, WorkRecord } from './work-record-transaction.js';
import { statusMain, statusPositions, statusView } from './status-records.js';
import { invariant } from './errors.js';

export type PendingStatusOptions = {
  detail?: boolean | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
};

/** R1 can supply its local successful-capture reader here. Until then coverage
 * is unknown. The reader must be synchronous, local and free of mutations. */
export type RecoveryCaptureReader = (store: WorkStore) => RecoveryCaptureObservation | null;
export function readPendingStatus(
  store: WorkStore,
  recovery?: RecoveryCaptureReader,
  now = new Date().toISOString(),
  options: PendingStatusOptions = {},
) {
  const { detail = false, offset = 0, limit = 5 } = options;
  invariant(
    Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0,
    'BAD_ARGUMENT',
    'Choose a nonnegative offset and positive page size.',
  );
  let observedLanes: Lane[] = [];
  const pagination: Record<
    string,
    { total: number; offset: number; more: boolean; nextOffset: number | null }
  > = {};
  return store.observing(() => {
    const tx = store.readRecords();
    const data = tx ? tx.data() : store.load();
    const records = <K extends WorkCollection>(collection: K, fields = true): WorkRecord<K>[] => {
      if (!tx) {
        const rows = (data[collection] ?? []) as WorkRecord<K>[];
        if (detail) return rows;
        const end = Math.max(0, rows.length - offset),
          start = Math.max(0, end - limit);
        pagination[collection] = {
          total: rows.length,
          offset,
          more: start > 0,
          nextOffset: start > 0 ? offset + limit : null,
        };
        return rows.slice(start, end);
      }
      const page = statusPositions(
        tx,
        collection,
        detail ? 0 : offset,
        detail ? (tx.manifest.collections[collection]?.count ?? 0) : limit,
      );
      const { items, ...meta } = page;
      pagination[collection] = meta;
      return items.reverse().map(position => {
        if (!detail && collection === 'views') return statusView(tx, position) as WorkRecord<K>;
        const selected = fields || !detail ? tx.fieldsAt(collection, position) : undefined;
        if (!detail && collection === 'lanes')
          return {
            ...(selected!.record as object),
            checkpointCount: selected!.counts.checkpoints ?? 0,
            lastCheckpointAt: (
              tx.fieldAt(
                'lanes',
                position,
                'checkpoints',
                Math.max(0, (selected!.counts.checkpoints ?? 0) - 1),
              ) as { at?: string } | undefined
            )?.at,
          } as WorkRecord<K>;
        return selected ? selected.record : tx.at(collection, position);
      });
    };
    const runs = records('runs');
    const views = records('views', false),
      channelMoves = records('channelMoves'),
      landingEntries = records('landingEntries'),
      lanes = records('lanes', false);
    // Exact references for the loaded page, including main, are selected by index.
    // Historical Lane/Intent/detail expansion remains explicit.
    const main = tx
      ? statusMain(tx)
      : data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted').at(-1);
    if (!detail && tx) {
      const active = statusPositions(
        tx,
        'runs',
        offset,
        limit,
        [
          ...new Set(
            ['queued', 'preparing', 'running'].flatMap(status => tx.positions('runs', status, 'status')),
          ),
        ].sort((a, b) => a - b),
      );
      const { items: activePositions, ...activeMeta } = active;
      pagination.activeChecks = activeMeta;
      for (const position of activePositions) {
        const run = tx.fieldsAt('runs', position).record;
        if (!runs.some(item => item.id === run.id)) runs.push(run);
      }
      for (const entry of landingEntries) {
        if (entry.runId && !runs.some(run => run.id === entry.runId)) {
          const run = tx.fields('runs', entry.runId)?.record;
          if (run) runs.push(run);
        }
      }
      const ids = new Set([
        ...runs.map(run => run.viewId),
        ...landingEntries.map(entry => entry.viewId),
        ...(main ? [main.viewId] : []),
      ]);
      for (const id of ids)
        if (!views.some(view => view.id === id)) {
          const position = tx.positions('views', id)[0];
          if (position !== undefined) views.push(statusView(tx, position));
        }
    }
    if (main && !channelMoves.some(move => move.id === main.id)) channelMoves.push(main);
    let evidenceChangedAt: string | null = null;
    // Observe file metadata, never read logs or hash/export an archive. A later
    // mtime can disprove coverage; an earlier mtime does not prove it.
    for (const run of detail ? runs : [])
      for (const name of runLogRecord(data, run, Date.parse(now)).status === 'included'
        ? ['stdout.log', 'stderr.log']
        : []) {
        try {
          const at = statSync(join(store.directory, `check-${run.id}`, name)).mtime.toISOString();
          if (!evidenceChangedAt || at > evidenceChangedAt) evidenceChangedAt = at;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    const host = readHostState(store);
    const pushes = [host.push, ...(host.pendingPushes ?? [])].filter(
      item =>
        !!item && item.projectId === host.binding?.projectId && item.deployment === host.binding?.deployment,
    );
    const deployment = tx
      ? tx.manifest.collections.deployments?.count
        ? tx.fieldsAt('deployments', tx.manifest.collections.deployments.count - 1).record
        : undefined
      : data.deployments?.at(-1);
    const pending = pendingStatus(
      {
        ...data,
        lanes: (observedLanes = lanes),
        intents: records('intents', false),
        views,
        runs,
        channelMoves,
        landingEntries,
      },
      {
        metrics: statusMetrics(
          store.root,
          { ...data, lanes, views, runs, channelMoves, landingEntries, landingBatches: [] },
          now,
        ),
        integrationPreview: detail ? integrationPreviewStatus(store) : undefined,
        landingWorker: readLandingWorkerStatus(store),
        submissions: detail ? readLaneSubmissions(store) : [],
        autoExchange: readAutoExchangeStatus(store, Date.parse(now)),
        recovery: recovery?.(store) ?? null,
        pendingPushes: pushes.map(push => ({ operationId: push!.operationId, revision: push!.revision })),
        metadataError: host.agentSync?.headError ?? null,
        metadataNextAttemptAt: host.agentSync?.nextAttemptAt ?? null,
        metadataRejected: host.agentSync?.rejected?.length ?? 0,
        metadataPending: host.agentSync?.pending.length ?? 0,
        waitingLaneIds: (detail ? waitingFinishes(store) : []).flatMap(command =>
          typeof command.laneId === 'string' ? [command.laneId] : [],
        ),
        evidenceChangedAt,
        deployment: deployment
          ? {
              head: deployment.head,
              observedAt: deployment.observation?.at ?? null,
              state: deployment.observation?.state ?? null,
            }
          : null,
      },
      now,
    );
    const pendingIds = new Set(
      pending.lanes.filter(lane => lane.status !== 'landed').map(lane => lane.laneId),
    );
    return {
      ...pending,
      pagination,
      queue: {
        ...(pagination.landingEntries ?? {
          total: landingEntries.length,
          offset: 0,
          more: false,
          nextOffset: null,
        }),
        items: landingEntries.map(entry => ({
          operationId: entry.id,
          viewId: entry.viewId,
          runId: entry.runId ?? null,
          channel: entry.channel,
          status: entry.status,
          arrivedAt: entry.arrivedAt,
        })),
      },
      countsScope: detail ? 'complete-records' : 'loaded-pages',
      sections: {
        skipped: detail
          ? []
          : [
              'overlap',
              'submissions',
              'lane-histories',
              'handoffs',
              'evidence-files',
              'waiting-finishes',
              'integration-preview',
            ],
        request: '--detail',
      },
      disk: readSelfMetricDisk(store.directory),
      overlap: detail
        ? savedOverlapPlan(
            store,
            observedLanes.filter(lane => pendingIds.has(lane.id)),
          )
        : pending.overlap,
    };
  });
}
