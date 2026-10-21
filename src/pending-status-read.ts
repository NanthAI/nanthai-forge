// SPDX-License-Identifier: Apache-2.0
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { waitingFinishes } from './agent-finish-journal.js';
import { readHostState } from './host-binding.js';
import { pendingStatus, type RecoveryCaptureObservation } from './pending-status.js';
import type { WorkStore } from './work-store.js';
import type { WorkCollection, WorkRecord } from './work-record-transaction.js';

/** R1 can supply its local successful-capture reader here. Until then coverage
 * is unknown. The reader must be synchronous, local and free of mutations. */
export type RecoveryCaptureReader = (store: WorkStore) => RecoveryCaptureObservation | null;
export function readPendingStatus(
  store: WorkStore,
  recovery?: RecoveryCaptureReader,
  now = new Date().toISOString(),
) {
  return store.locked(() =>
    store.observing(() => {
      const tx = store.readRecords();
      const data = tx ? tx.data() : store.load();
      const records = <K extends WorkCollection>(collection: K, fields = true): WorkRecord<K>[] => {
        if (!tx) return (data[collection] ?? []) as WorkRecord<K>[];
        return Array.from({ length: tx.manifest.collections[collection]?.count ?? 0 }, (_, i) =>
          fields ? tx.fieldsAt(collection, i).record : tx.at(collection, i),
        );
      };
      const runs = records('runs');
      let evidenceChangedAt: string | null = null;
      // Observe file metadata, never read logs or hash/export an archive. A later
      // mtime can disprove coverage; an earlier mtime does not prove it.
      for (const run of runs)
        for (const name of ['stdout.log', 'stderr.log']) {
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
          !!item &&
          item.projectId === host.binding?.projectId &&
          item.deployment === host.binding?.deployment,
      );
      const deployment = records('deployments').at(-1);
      return pendingStatus(
        {
          ...data,
          lanes: records('lanes'),
          views: records('views', false),
          runs,
          channelMoves: records('channelMoves'),
          landingEntries: records('landingEntries'),
        },
        {
          recovery: recovery?.(store) ?? null,
          pendingPushes: pushes.map(push => ({ operationId: push!.operationId, revision: push!.revision })),
          metadataPending: host.agentSync?.pending.length ?? 0,
          waitingLaneIds: waitingFinishes(store).flatMap(command =>
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
    }),
  );
}
