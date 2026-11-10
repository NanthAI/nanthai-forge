// SPDX-License-Identifier: Apache-2.0
import { workerPath } from './worker-install.js';
import { checkServiceEnv } from './worker-environment.js';
import { effectivePolicy as childPolicy } from './autonomy-policy.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { WorkStore } from './work-store.js';
import { readLandingWorkerStatus } from './landing-worker-status.js';
import { wakeLandingWorker } from './landing-worker-wake.js';
const started = new Set<string>();
/** Worker ownership is reconciled across CLI/MCP processes by the existing process queue. */
export function startPresenceWorker(store: WorkStore) {
  if (!process.argv[1]?.endsWith('/cli.js') || !existsSync(join(store.directory, 'work.json'))) return;
  const key = store.root;
  if (started.has(key)) return;
  if (readLandingWorkerStatus(store).workers) {
    wakeLandingWorker(store);
    return;
  }
  store.revision();
  started.add(key);
  // FORGE_AUTH_TOKEN authenticates hosted metadata emitted by this owner driver.
  const child = spawn(
    process.execPath,
    [workerPath(new URL('./presence-worker.js', import.meta.url)), store.root],
    {
      detached: true,
      stdio: 'ignore',
      env: checkServiceEnv(
        store.page('checks', 0, Number.MAX_SAFE_INTEGER).records,
        childPolicy(store.readRecords()?.data() ?? store.load()),
        [
          'FORGE_AUTH_TOKEN',
          'FORGE_PRESENCE_TOUCH_MS',
          'FORGE_PRESENCE_IDLE_MS',
          'FORGE_PRESENCE_GUARD_MS',
          'FORGE_PRESENCE_DEBUG_FILE',
          'FORGE_AUTO_SNAPSHOT_DEBOUNCE_MS',
          'FORGE_AUTO_SNAPSHOT_INTERVAL_MS',
          'FORGE_AUTO_SNAPSHOT_MAX_WAIT_MS',
        ],
      ),
    },
  );
  child.once('error', () => started.delete(key));
  child.once('exit', () => started.delete(key));
  child.unref();
}
