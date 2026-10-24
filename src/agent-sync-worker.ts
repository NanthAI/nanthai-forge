// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CheckQueue, queueEntries } from './check-queue.js';
import { processStartTime } from './local-process.js';
import { readHostState } from './host-binding.js';
import type { WorkStore } from './work-store.js';

/** Reserve before spawning, then keep the reservation while the detached child lives. */
export function startAgentSyncWorker(store: WorkStore) {
  const admission = new CheckQueue(join(store.directory, 'hosted-agent-sync-spawn'), {
    limit: 1,
    anchor: store.directory,
  });
  try {
    if (!admission.tryAcquire()) return false;
    const state = readHostState(store);
    if (
      !state.binding ||
      state.binding.autoSync === false ||
      !state.agentSync?.pending.length ||
      (state.agentSync.nextAttemptAt ?? 0) > Date.now() ||
      queueEntries(join(store.directory, 'hosted-agent-sync-queue')).length
    )
      return false;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.js', import.meta.url)), 'host', store.root, '--sync-agent'],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.once('error', () => {});
    if (child.pid) admission.child(child.pid, processStartTime(child.pid));
    child.unref();
    return !!child.pid;
  } finally {
    admission.release();
  }
}
