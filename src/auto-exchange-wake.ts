// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { ownerEnvNames } from './worker-environment.js';
import { autoDriverStalled } from './push-progress-state.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effectivePolicy } from './autonomy-policy.js';
import { readHostState } from './host-binding.js';
import { readPendingExchange } from './pending-exchange.js';
import { processAlive } from './local-process.js';
import { notifyAutoExchange } from './auto-exchange-notify.js';
import type { WorkStore } from './work-store.js';

const scheduled = new Set<string>();
/** Deferred until after the synchronous owner commit releases its lock. Startup
 * and every save recover lost wakeups. No timer/subscription exists when idle. */
export function wakeAutoExchange(store: WorkStore, afterDrain = false, launch: typeof spawn = spawn) {
  if ((!afterDrain && process.env.FORGE_AUTO_EXCHANGE_WORKER === '1') || scheduled.has(store.directory))
    return;
  scheduled.add(store.directory);
  setImmediate(() => {
    scheduled.delete(store.directory);
    try {
      const host = readHostState(store),
        binding = host.binding;
      const state = host.autoExchange;
      if (state?.worker && processAlive(state.worker)) {
        if (state.wakeEndpoint) notifyAutoExchange(state.wakeEndpoint);
        if (!autoDriverStalled(host)) return;
        // A successor waits for cooperative cancellation and the existing queue
        // slots. Never remove a live holder or send an OS process signal.
      }
      const policy = effectivePolicy(store.readRecords()?.data() ?? store.load()).autoExchange;
      if (!policy?.enabled || !binding || host.hosting) return;
      const queued = readPendingExchange(store.directory);
      const retained = [host.push, ...(host.pendingPushes ?? [])].some(
        push => push?.projectId === binding.projectId && push.deployment === binding.deployment,
      );
      if (!queued?.pending.length && !retained) return;
      if (
        !retained &&
        state?.projectId === binding.projectId &&
        state.deployment === binding.deployment &&
        state.status === 'incomplete' &&
        state.handledSequence === queued?.sequence
      )
        return;
      // FORGE_AUTH_TOKEN authenticates this worker's hosted source/metadata requests.
      const child = launch(
        process.execPath,
        [fileURLToPath(new URL('./auto-exchange.js', import.meta.url)), store.root],
        {
          detached: true,
          stdio: 'ignore',
          env: childEnv({
            allow: [...ownerEnvNames, 'FORGE_AUTH_TOKEN'],
            extra: { FORGE_AUTO_EXCHANGE_WORKER: '1' },
          }),
        },
      );
      child.on('error', () => {
        /* Next startup/save retries the durable queue. */
      });
      child.unref();
    } catch {
      /* Wakeup never changes the outcome of already-saved Work. */
    }
  });
}
