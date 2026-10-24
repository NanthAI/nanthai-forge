import { wakeLandingWorker } from './landing-worker-wake.js';
import { resumeLegacyLand } from './landing-worker-journals.js';
import type { AgentWorkflow } from './agent-workflow.js';
import { land } from './land.js';
import { drainLandingBatches } from './landing-batch.js';
// SPDX-License-Identifier: Apache-2.0
import { watch, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unfinishedFinishes } from './agent-finish-journal.js';
import { pendingLands } from './land-journal.js';
import { openAutoExchangeNotifications } from './auto-exchange-notify.js';
import { waitingDependencies } from './agent-dependencies.js';
import { processIdentity, processAlive } from './local-process.js';
import { recoverRecordRuns } from './work-record-runs.js';
import { ForgeError } from './errors.js';
import { withLandingWorker, assertLandingWorkerActive } from './landing-worker-context.js';
import { saveLandingWorkerState, type LandingWorkerState } from './landing-worker-status.js';
import type { WorkStore } from './work-store.js';

/** Owner service/detached-worker lifecycle owns this driver, never a reader.
 * Subscribe before the startup scan; sequence invalidation closes snapshot/wait races.
 * Work and exact-run receipts are durable; notifications carry no queue authority. */
export async function watchLandingWorker(store: WorkStore, signal: AbortSignal) {
  if (!store.native || signal.aborted) return;
  // Unsupported Work must fail before any service control state is created.
  store.load();
  const notifications = await openAutoExchangeNotifications();
  const id = randomUUID(),
    worker = processIdentity();
  let sequence = 0,
    resume: (() => void) | undefined;
  const wake = () => {
    sequence++;
    resume?.();
  };
  const unsubscribe = notifications.subscribe(wake);
  const watcher = watch(store.directory, { recursive: true }, (_event, filename) => {
    const path = filename?.toString().replaceAll('\\', '/');
    // A failed nonblocking admission stays retryable, but our own transient
    // ticket creation/release must not repeatedly wake that same attempt.
    const ticket = path?.match(/^landing-batch-drain\/[^/]+\/([^/]+)/)?.[1];
    if (ticket?.startsWith(`${process.pid}.`)) return;
    if (
      !path ||
      path === 'work.json' ||
      /^(?:agent-land|agent-finish)\/[0-9a-f-]+\.json$/.test(path) ||
      /^check-[^/]+\/result\.json$/.test(path) ||
      /^landing-batch-drain\//.test(path)
    )
      wake();
  });
  watcher.on('error', wake);
  signal.addEventListener('abort', wake, { once: true });
  let affected: LandingWorkerState['affected'];
  const publish = (status: LandingWorkerState['status'], code?: string) =>
    saveLandingWorkerState(store, {
      schema: 1,
      id,
      worker,
      endpoint: notifications.endpoint,
      status,
      observedAt: new Date().toISOString(),
      ...(code ? { code } : {}),
      ...(code && affected ? { affected } : {}),
    });
  let agent: AgentWorkflow | undefined;
  let last = '';
  try {
    publish('recovering');
    await withLandingWorker(signal, async () => {
      while (!signal.aborted) {
        const observed = sequence;
        const data = store.load(),
          finishes = unfinishedFinishes(store),
          lands = pendingLands(store);
        // An exact result receipt can change without a Work publication. Peer
        // releases retry unsuccessful admission, never a handled snapshot.
        const activeChannels = new Set(
          (data.landingEntries ?? [])
            .filter(e => ['queued', 'checking'].includes(e.status))
            .map(e => e.channel),
        );
        // Idle lifecycle startup does not need the full agent execution graph.
        if (
          !agent &&
          (activeChannels.size ||
            finishes.length ||
            lands.length ||
            data.landingBatches?.some(batch => ['composing', 'checking'].includes(batch.status)))
        ) {
          const { AgentWorkflow } = await import('./agent-workflow.js');
          agent = new AgentWorkflow(store.root);
        }
        const receipts = data.runs
          .filter(run => ['queued', 'preparing', 'running'].includes(run.status))
          .map(run => {
            const alive = processAlive(run.runner);
            try {
              const s = statSync(join(store.directory, `check-${run.id}`, 'result.json'));
              return [run.id, alive, s.ino, s.mtimeMs, s.size];
            } catch {
              return [run.id, alive];
            }
          });
        const key = JSON.stringify([
          data.revision,
          receipts,
          finishes.map(c => c.operationId),
          lands.map(c => c.operationId),
        ]);
        if (key !== last) {
          last = key;
          try {
            let failed = false;
            const attempt = async (task: () => Promise<unknown>) => {
              try {
                await task();
              } catch (error) {
                if (signal.aborted) throw error;
                failed = true;
                last = '';
                publish('error', error instanceof ForgeError ? error.code : 'LANDING_WORKER_FAILED');
              }
            };
            affected = undefined;
            // Recovery precedes journal replay, even when that journal fails.
            // Remote controllers adopt original IDs; dead local commands end.
            // Idle/terminal-only observations must not compete with Lane writes.
            if (receipts.length) store.locked(() => recoverRecordRuns(store, store.records()));
            const channels = new Set([
              ...(data.landingEntries ?? [])
                .filter(e => ['queued', 'checking'].includes(e.status))
                .map(e => e.channel),
              ...(data.landingBatches ?? [])
                .filter(b => ['composing', 'checking'].includes(b.status))
                .map(b => b.channel),
            ]);
            if (channels.size || finishes.length || lands.length) publish('driving');
            for (const channel of channels) {
              assertLandingWorkerActive();
              const entry = data.landingEntries?.find(
                e => e.channel === channel && ['queued', 'checking'].includes(e.status),
              );
              affected = {
                channel,
                ...(entry ? { operationId: entry.id } : {}),
                laneIds: entry
                  ? (data.views.find(view => view.id === entry.viewId)?.inputs.map(pin => pin.laneId) ?? [])
                  : [],
                ...(entry?.runId ? { runId: entry.runId } : {}),
              };
              await attempt(async () => {
                try {
                  const drained = await drainLandingBatches(agent!.work, channel, 0, undefined, batch => {
                    const prefix = batch.prefixes.at(-1);
                    affected = {
                      channel,
                      operationId: batch.id,
                      laneIds: [
                        ...new Set(
                          batch.entryIds.flatMap(id => {
                            const entry = store.select('landingEntries', id);
                            return entry
                              ? (store.select('views', entry.viewId)?.inputs.map(pin => pin.laneId) ?? [])
                              : [];
                          }),
                        ),
                      ],
                      ...(prefix ? { runId: prefix.runId } : {}),
                    };
                  });
                  // A peer may still be choosing its bakery ticket. No holding
                  // ticket or Work revision need change when that peer releases it.
                  if ('waiting' in drained) last = '';
                } finally {
                  // Releasing a drain slot need not publish Work. Notify peers
                  // explicitly: native filesystem events may be delayed or lost.
                  // Exclude ourselves so contention cannot create a wake loop.
                  wakeLandingWorker(store, id);
                }
              });
            }
            for (const retained of lands) {
              assertLandingWorkerActive();
              affected = {
                operationId: retained.operationId,
                laneIds: retained.state.entries.flatMap(entry => entry.inputs.map(pin => pin.laneId)),
              };
              if (!retained.command) {
                await attempt(() => resumeLegacyLand(agent!.work, retained.operationId));
                continue;
              }
              // A blocked request remains quiet until a durable dependency change.
              if (waitingDependencies(store, retained.command.laneIds, retained.command.channel).length)
                continue;
              await attempt(() => land(agent!.work, retained.command!, retained.selection));
            }
            for (const command of finishes) {
              assertLandingWorkerActive();
              const laneIds = [command.laneId, ...((command.with as string[] | undefined) ?? [])].filter(
                (v): v is string => typeof v === 'string',
              );
              const channel = (command.accept as { channel?: string } | undefined)?.channel;
              affected = {
                operationId: command.operationId as string,
                laneIds,
                ...(channel ? { channel } : {}),
              };
              if (waitingDependencies(store, laneIds, channel).length) continue;
              await attempt(() => agent!.dispatch(command));
            }
            if (!failed) publish('idle');
          } catch (error) {
            if (signal.aborted) break;
            // A failed observation is not a handled revision. A queue release
            // or explicit wake can make it retryable without a Work mutation.
            last = '';
            publish('error', error instanceof ForgeError ? error.code : 'LANDING_WORKER_FAILED');
          }
        }
        if (signal.aborted) break;
        if (observed !== sequence) continue;
        await new Promise<void>(resolve => {
          resume = resolve;
          if (observed !== sequence || signal.aborted) resolve();
        });
        resume = undefined;
      }
    });
  } finally {
    signal.removeEventListener('abort', wake);
    watcher.close();
    unsubscribe();
    await notifications.close();
    publish('stopped');
  }
}
