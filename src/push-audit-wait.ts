// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ForgeError } from './errors.js';
import { workProgress } from './work-progress.js';
import type { WorkStore } from './work-store.js';

/** The worker joins the existing audit queue and reconciles its retained run.
 * Keep its command pipes out of this CLI: timing out observation must neither
 * cancel the audit nor keep the caller alive until that command completes. */
export async function waitPushAudit(
  store: WorkStore,
  audit: { channel: string; checkId: string } | undefined,
  timeoutMs: number,
) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./post-accept-main.js', import.meta.url)),
      store.root,
      ...(audit ? [JSON.stringify(audit)] : []),
    ],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  let failed = false;
  child.on('error', () => {
    failed = true;
  });
  child.unref();
  const end = Date.now() + timeoutMs;
  let reportedAt = -Infinity;
  while (!failed && child.exitCode === null && child.signalCode === null) {
    const left = end - Date.now();
    if (left <= 0)
      throw new ForgeError(
        'GITHUB_SYNC_AUDIT_TIMEOUT',
        'Main audit wait expired; its worker and original run are retained. Retry github-sync --push --wait-audit.',
      );
    if (Date.now() - reportedAt >= 5000) {
      const run = store.load().runs.find(run => run.mainCheck && !run.endedAt);
      workProgress(
        'waiting for main audit',
        run ? `run=${run.id} status=${run.status}` : 'Waiting for retained audit worker',
      );
      reportedAt = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(250, left)));
  }
  if (failed || child.exitCode !== 0)
    throw new ForgeError(
      'GITHUB_SYNC_AUDIT_FAILED',
      'Main audit worker stopped without completing. Retry to reconcile its retained run.',
    );
}
