// SPDX-License-Identifier: Apache-2.0
import { requireHostedBinding, updateHostState } from './host-binding.js';
import { processIdentity } from './local-process.js';
import { withExchangeProgress } from './exchange-progress.js';
import type { WorkStore } from './work-store.js';

/** Called only inside the bound-push slot. Actual phases/bytes renew progress;
 * console heartbeats do not. Keep writes below one per second within a phase. */
export async function withBoundPushProgress<T>(store: WorkStore, run: () => Promise<T>) {
  const binding = requireHostedBinding(store);
  const worker = processIdentity();
  let active = true;
  let lastPhase = '',
    lastWrite = 0;
  const progress = (phase: string, advanced = true) => {
    if (!active) return;
    const now = Date.now();
    if (phase === lastPhase && (!advanced || now - lastWrite < 1000)) return;
    updateHostState(store, host => {
      if (host.binding?.projectId !== binding.projectId || host.binding.deployment !== binding.deployment)
        return;
      const pending = [host.push, ...(host.pendingPushes ?? [])].find(
        push => push?.projectId === binding.projectId && push.deployment === binding.deployment,
      );
      host.pushProgress = {
        projectId: binding.projectId,
        deployment: binding.deployment,
        ...(pending ? { operationId: pending.operationId } : {}),
        worker,
        phase,
        lastProgressAt: now,
      };
    });
    lastPhase = phase;
    lastWrite = now;
  };
  try {
    progress('preparing exchange push');
    return await withExchangeProgress({ progress }, run);
  } finally {
    active = false;
    updateHostState(store, host => {
      if (
        host.pushProgress?.worker.pid === worker.pid &&
        host.pushProgress.worker.startTime === worker.startTime
      )
        delete host.pushProgress;
    });
  }
}
