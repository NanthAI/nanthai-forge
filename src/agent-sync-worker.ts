// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncUnprepared } from './agent-sync-state.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CheckQueue, queueEntries } from './check-queue.js';
import { processStartTime } from './local-process.js';
import { readHostState, type HostState } from './host-binding.js';
import { checkServiceEnv } from './worker-environment.js';
import { effectivePolicy } from './autonomy-policy.js';
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
      syncUnprepared(state) ||
      (state.agentSync.nextAttemptAt ?? 0) > Date.now() ||
      queueEntries(join(store.directory, 'hosted-agent-sync-queue')).length
    )
      return false;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.js', import.meta.url)), 'host', store.root, '--sync-agent'],
      {
        detached: true,
        stdio: 'ignore',
        // host --sync-agent publishes metadata and consumes owner requests,
        // which can queue checks using the owner's selected backend and inputs.
        env: checkServiceEnv(
          store.page('checks', 0, Number.MAX_SAFE_INTEGER).records,
          effectivePolicy(store.readRecords()?.data() ?? store.load()),
          ['FORGE_AUTH_TOKEN', 'FORGE_DEPLOYMENT_URL'],
        ),
      },
    );
    child.once('error', () => {});
    if (child.pid) admission.child(child.pid, processStartTime(child.pid));
    child.unref();
    return !!child.pid;
  } finally {
    admission.release();
  }
}

/** Call after successful local prepare, or an explicit operator retry; never prepares hosted Work. */
export function markAgentSyncPrepared(state: HostState, target: { projectId: string; deployment: string }) {
  if (state.binding?.projectId !== target.projectId || state.binding.deployment !== target.deployment) return;
  state.binding.workIndexPreparation = randomUUID();
  if (state.agentSync?.unprepared) {
    delete state.agentSync.unprepared;
    if (state.agentSync.headError?.code === 'PROJECT_WORK_INDEX_MISSING') {
      delete state.agentSync.headError;
      delete state.agentSync.nextAttemptAt;
    }
  }
}
