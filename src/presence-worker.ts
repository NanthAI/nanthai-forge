// SPDX-License-Identifier: Apache-2.0
import { detachedWorker } from './detached-worker-shutdown.js';
import { existsSync } from 'node:fs';
import { watchLocal } from './local-watcher.js';
import { join } from 'node:path';
import { WorkStore } from './work-store.js';
import { withQueueSlot } from './landing-queue.js';
import { queueAgentSync } from './agent-hosted-sync.js';
import { PRESENCE, collapseSessions } from './presence.js';
import { exclusion } from './files.js';
import { observePresenceFiles } from './presence-files.js';
import { PeersSource } from './agent-peers-source.js';
import { changedPaths } from './agent-sync.js';
import { readHostState } from './host-binding.js';
import { guardOwnerWorker } from './presence-worker-guard.js';
import { laneAutoSnapshots } from './lane-auto-snapshot.js';

/** Timer period for presence observation; the env override exists so tests can make timers certain to fire. */
const touchMs = () => Number(process.env.FORGE_PRESENCE_TOUCH_MS) || PRESENCE.touchMs;
/** Set once this worker has seen its owner dying (a live Lane's directory vanished). From then on no timer
 * writes under the owner: a write during someone's `rm -r` can make it fail or leave files behind. */
let ownerDying = false;

/** Native notifications, plus macOS metadata reconciliation when FSEvents is delayed or drops events. */
export async function watchLanePresence(
  store: WorkStore,
  laneId: string,
  signal?: AbortSignal,
  onEdit?: (laneId: string) => void,
) {
  if (signal?.aborted) return;
  // Validate the current Work format before queue admission writes a ticket.
  store.revision();
  return withQueueSlot(
    join(store.directory, 'presence-workers', laneId),
    () =>
      new Promise<void>(resolve => {
        let edited = false;
        // Debounced recovery snapshots ride on the same edit observations; no extra polling.
        const snapshots = laneAutoSnapshots(store, laneId, !!signal);
        const edit = () => {
          snapshots.edited();
          onEdit?.(laneId);
        };
        const metadata = observePresenceFiles(store.path(laneId));
        const observeFiles = process.platform === 'darwin' ? metadata : undefined;
        if (observeFiles) {
          // A detached observer can attach after the first edit. Compare the live
          // source with the saved head once; subsequent ticks need metadata only.
          try {
            const lane = store.select('lanes', laneId);
            if (lane) {
              const source = new PeersSource(store, lane.base);
              edited = changedPaths(source.state(lane.head).files, source.live(lane)).length > 0;
            }
          } catch {
            /* Advisory initialization; later metadata changes still reconcile. */
          }
        }
        if (!existsSync(store.path(laneId)) && existsSync(store.directory)) {
          ownerDying = true;
          snapshots.close();
          return;
        }
        const watcher = watchLocal(
          store.path(laneId),
          {
            recursive: true,
            onReady: () => {
              // Helper startup/open is asynchronous. Linux inotify cannot replay
              // edits made before attachment; reconcile the snapshot taken above
              // once native watching is installed, including after recovery.
              if (metadata()) {
                edited = true;
                edit();
              }
            },
          },
          (_event, filename) => {
            if (!existsSync(store.directory)) return close();
            if (filename && !exclusion(filename.replaceAll('\\', '/'))) {
              if (!observeFiles) edited = true;
              edit();
            }
          },
        );
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          snapshots.close();
          signal?.removeEventListener('abort', close);
          void watcher.close().then(resolve);
        };
        if (signal) watcher.unref();
        const touch = () => {
          if (ownerDying) return;
          const reconcileFiles = observeFiles ?? (watcher.health.status !== 'healthy' ? metadata : undefined);
          void watcher.probe();
          try {
            if (!existsSync(store.directory)) return close();
            const lane = store.select('lanes', laneId);
            if (!lane) return close();
            if (
              lane.state === 'completed' ||
              store.select('intents', lane.intentId)?.status === 'abandoned'
            ) {
              for (const session of Object.values(readHostState(store).presence ?? {}).filter(
                session => session.context.laneId === laneId && session.status !== 'completed',
              ))
                queueAgentSync(
                  store,
                  { action: 'activity', laneId, actor: session.name },
                  {},
                  false,
                  'completed',
                );
              return close();
            }
            if (!existsSync(store.path(laneId))) {
              ownerDying = true;
              return;
            }
            if (reconcileFiles?.()) {
              edited = true;
              edit();
            }
            const sessions = collapseSessions(Object.values(readHostState(store).presence ?? {})).filter(
              session => session.context.laneId === laneId,
            );
            if (sessions.length && sessions.every(session => session.status === 'completed')) return close();
            const tx = store.readRecords();
            const runs = tx
              ? ['queued', 'preparing', 'running'].flatMap(status => tx.all('runs', status, 'status'))
              : store.load().runs;
            const run = runs.find(
              run =>
                ['queued', 'preparing', 'running'].includes(run.status) &&
                store.select('views', run.viewId)?.inputs.some(input => input.laneId === laneId),
            );
            const kind = run
              ? run.status === 'queued'
                ? 'check queued'
                : 'check running'
              : edited
                ? 'edited files'
                : undefined;
            if (kind) {
              // The Lane's named actor is retained, not the local server's identity.
              const actors = sessions.length
                ? sessions.filter(session => session.status !== 'completed')
                : [{ name: lane.startedBy?.name }];
              let recorded = true;
              for (const session of actors) {
                const result = queueAgentSync(
                  store,
                  { action: 'activity', laneId, ...(session.name ? { actor: session.name } : {}) },
                  {},
                  false,
                  kind,
                );
                if (result?.status === 'deferred') recorded = false;
              }
              if (recorded) edited = false;
            }
          } catch {
            /* Advisory observation retries next minute; never changes source or work success. */
          }
        };
        const timer = setInterval(touch, touchMs());
        // A restarted observer snapshots edits a dead process left unsaved. Only macOS
        // compared the live source with the head above; elsewhere one cached capture decides.
        if (edited || !observeFiles) snapshots.edited();
        if (edited) touch();
        if (signal) timer.unref?.();
        signal?.addEventListener('abort', close, { once: true });
        if (signal?.aborted) close();
      }),
    { waitMs: 0, anchor: store.directory },
  );
}
/** One detached process per owner, with native Lane watchers. No process per session. */
export async function watchOwnerPresence(
  store: WorkStore,
  signal?: AbortSignal,
  onEdit?: (laneId: string) => void,
  lifecycle?: (signal: AbortSignal) => Promise<void>,
) {
  if (signal?.aborted) return;
  // Validate the current Work format before queue admission writes a ticket.
  store.revision();
  return withQueueSlot(
    join(store.directory, 'presence-owner'),
    () =>
      new Promise<void>(resolve => {
        const lanes = new Map<string, { controller: AbortController; pending: Promise<unknown> }>();
        const lifecycleController = new AbortController();
        let lifecyclePending: Promise<void> | undefined;
        let closed = false;
        const reconcile = () => {
          if (closed || ownerDying) return;
          if (!existsSync(store.directory)) return close();
          try {
            const sessions = collapseSessions(Object.values(readHostState(store).presence ?? {}));
            let vanished = false;
            const tx = store.readRecords();
            const retained = tx
              ? Array.from(
                  { length: tx.manifest.collections.lanes?.count ?? 0 },
                  (_, i) => tx.fieldsAt('lanes', i).record,
                )
              : store.load().lanes;
            const active = retained.filter(lane => {
              const observed = sessions.filter(session => session.context.laneId === lane.id);
              const live =
                lane.state !== 'completed' &&
                store.select('intents', lane.intentId)?.status !== 'abandoned' &&
                (!observed.length || observed.some(session => session.status !== 'completed'));
              const present = live && existsSync(store.path(lane.id));
              if (live && !present) vanished = true;
              return present;
            });
            for (const lane of active) {
              if (lanes.has(lane.id)) continue;
              const controller = new AbortController();
              const pending = watchLanePresence(store, lane.id, controller.signal, onEdit)
                .catch(() => undefined)
                .finally(() => lanes.delete(lane.id));
              lanes.set(lane.id, { controller, pending });
            }
            // A live Lane whose directory vanished means the owner is being deleted. Closing now would
            // delete our queue tickets inside it while that `rm -r` runs, and any timer write would add
            // entries to it: stop every writer and wait for the guard to end the process.
            if (vanished) {
              ownerDying = true;
              clearInterval(timer);
            } else if (!active.length && !lifecycle) close();
          } catch {
            if (!existsSync(store.directory)) close();
          }
        };
        const watcher = watchLocal(store.directory, { onReady: reconcile }, (_event, filename) => {
          // Each successful lifecycle observation atomically replaces this file after its Lane exists.
          if (filename?.toString() === 'hosted-binding.json') reconcile();
        });
        const timer = setInterval(() => {
          void watcher.probe();
          reconcile();
        }, touchMs());
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          const watcherClosed = watcher.close();
          signal?.removeEventListener('abort', close);
          const pending = [...lanes.values()];
          for (const { controller } of pending) controller.abort();
          lifecycleController.abort();
          void Promise.all([...pending.map(lane => lane.pending), lifecyclePending, watcherClosed]).then(() =>
            resolve(),
          );
        };
        if (signal) watcher.unref();
        if (signal) timer.unref?.();
        signal?.addEventListener('abort', close, { once: true });
        if (signal?.aborted) close();
        else {
          lifecyclePending = lifecycle?.(lifecycleController.signal).catch(() => {
            close();
          });
          reconcile();
        }
      }),
    { waitMs: 0, anchor: store.directory },
  );
}
if (process.argv[1]?.endsWith('/presence-worker.js') && process.argv[2]) {
  await detachedWorker(async signal => {
    const store = new WorkStore(process.argv[2]!);
    const guard = guardOwnerWorker(store, () => process.exit(0), { runtime: process.argv[1] });
    // Observers are unreferenced; the process owns them until shutdown.
    const keepAlive = setInterval(() => undefined, 60_000);
    try {
      await watchOwnerPresence(store, signal, guard.touch, async lifecycleSignal => {
        const { watchLandingWorker } = await import('./landing-worker.js');
        await watchLandingWorker(store, lifecycleSignal);
      });
    } finally {
      clearInterval(keepAlive);
      guard.close();
    }
  }).catch(() => undefined);
  process.exit(0);
}
