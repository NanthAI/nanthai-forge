import { readLandCheckController } from './land-check-progress.js';
import { landingWaitMs, assertLandingWorkerActive } from './landing-worker-context.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
// SPDX-License-Identifier: Apache-2.0
import { CheckQueue, queueHolder } from './check-queue.js';
import { workProgress, workProgressIdentity, observeWorkProgress } from './work-progress.js';
import { ForgeError, invariant } from './errors.js';
import type { CheckRun } from './work-types.js';
import { SelectedRunObserver } from './work-run-observation.js';
import { recoverRuns } from './work-run.js';
import type { WorkStore } from './work-store.js';

const active = (run: CheckRun) =>
  run.status === 'queued' || run.status === 'preparing' || run.status === 'running';

export async function waitForAgentRun(
  store: WorkStore,
  operationId: string,
  waitMs?: number,
  progress = true,
): Promise<void> {
  assertLandingWorkerActive();
  waitMs = landingWaitMs(waitMs);
  const end = waitMs === undefined ? Infinity : Date.now() + waitMs,
    reader = new SelectedRunObserver(store, operationId);
  for (;;) {
    let run: CheckRun;
    try {
      run = reader.read();
    } catch (error) {
      // A concurrent publication can invalidate a filesystem read. Keep following
      // this run rather than returning a finish receipt while its check is live.
      if (!(error instanceof ForgeError && error.code === 'SOURCE_CHANGED')) throw error;
      if (Date.now() >= end) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
      continue;
    }
    observeWorkProgress();
    if (!active(run)) return;
    if (progress) {
      const queue =
        run.backend?.actual === 'modal'
          ? CheckQueue.observe(
              run.id,
              join(
                process.env.FORGE_CHECK_QUEUE_DIR ?? join(homedir(), '.forge'),
                run.mainCheck ? 'modal-audit-queue' : 'modal-check-queue',
              ),
            )
          : CheckQueue.observe(run.id);
      const control = readLandCheckController(store, run);
      const holder = control?.holder
        ? {
            ...control.holder,
            actor: `${control.holder.lease ? 'check controller' : 'runner'} pid ${control.holder.pid}`,
            phase: control.phase,
          }
        : undefined;
      const capacity =
        run.status === 'queued' && queue?.holder ? ` capacity holder=${queueHolder(queue.holder)}` : '';
      workProgress(
        run.status === 'queued'
          ? 'queued for check'
          : run.status === 'preparing'
            ? 'preparing check'
            : 'running check',
        `${workProgressIdentity().runId === run.id ? '' : `run=${run.id} `}queue position=${queue?.position ?? 0}${capacity} holder=${queueHolder(holder)}${control?.holder?.lease ? ` lease=${control.holder.lease}` : ''}`,
      );
    }
    // The existing recovery rules inspect a durable receipt or established local runner death.
    // A copy prevents an observation outside the lock from changing retained metadata.
    if (recoverRuns(store, { runs: [structuredClone(run)] })) {
      try {
        const terminal = store.locked(() => {
          const tx = store.records(),
            found = tx.find('runs', operationId),
            selected = found?.record;
          invariant(selected, 'NOT_FOUND', 'Run not found.');
          if (recoverRuns(store, { runs: [selected] })) {
            tx.replace('runs', found!.position, selected);
            store.commitRecords(tx);
          }
          return !active(selected);
        });
        if (terminal) return;
      } catch (error) {
        if (!(error instanceof ForgeError && ['WORK_BUSY', 'SOURCE_CHANGED'].includes(error.code)))
          throw error;
      }
    }
    if (Date.now() >= end) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
  }
}
