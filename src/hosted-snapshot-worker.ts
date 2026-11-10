// SPDX-License-Identifier: Apache-2.0
import { isMainModule } from '../scripts/main-module.mjs';
import { spawn } from 'node:child_process';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { workerPath } from './worker-install.js';
import { withExchangeProgress } from './exchange-progress.js';
import {
  markTimedSnapshot,
  snapshotDirectory,
  snapshotLockHeld,
  snapshotSettings,
  timedSnapshotDue,
} from './lane-snapshot-hint.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

/** Unsaved-work snapshots run in a short-lived detached process, so a command never waits for the
 * walk of the working files or the uploads (Issue 7ac4e32f). It takes the same lock, keeps the same
 * retained request and takes the same snapshot as an in-process one; killed at any point, the next
 * command or the turn-end hook finishes or replaces it. */
const MIN_GAP_MS = 3_000;
const WORKER_DEADLINE_MS = 60_000;
export const snapshotWorkerTestHooks: { launch?: typeof spawn } = {};

/** Start the worker for a Lane checkout: the timed snapshot. Skips while the project's interval
 * (policy autoSnapshotIntervalMinutes) has not passed since this checkout's last timed snapshot
 * (the latest state wins: the first command after the interval, or the turn end, takes it), when a
 * snapshot of it is running, or when one started within the last few seconds (a burst of commands
 * snapshots once). Never throws or waits. */
export function launchSnapshotWorker(root: string, address: HostedAgentAddress): boolean {
  try {
    if (!timedSnapshotDue(root, snapshotSettings(root).intervalMinutes)) return false;
    if (snapshotLockHeld(root)) return false;
    const stamp = join(snapshotDirectory(root), 'worker');
    try {
      if (Date.now() - statSync(stamp).mtimeMs < MIN_GAP_MS) return false;
      utimesSync(stamp, new Date(), new Date());
    } catch {
      writeFileSync(stamp, '', { mode: 0o600 });
    }
    const child = (snapshotWorkerTestHooks.launch ?? spawn)(
      process.execPath,
      [workerPath(import.meta.url), root, address.url, address.projectId],
      { detached: true, stdio: 'ignore', env: childEnv({ allow: ['FORGE_AUTH_TOKEN'] }) },
    );
    child.on('error', () => {
      /* The next command or the turn end snapshots instead. */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  const [root, url, projectId] = process.argv.slice(2);
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), WORKER_DEADLINE_MS).unref();
  try {
    if (root && url && projectId) {
      const { ConvexExchange } = await import('./exchange-client.js');
      const { snapshotLaneCheckout } = await import('./hosted-lane-snapshot.js');
      const exchange = new ConvexExchange(url, process.env.FORGE_AUTH_TOKEN, projectId, '', null);
      const taken = await withExchangeProgress({ signal: cancel.signal }, () =>
        snapshotLaneCheckout(root, projectId, exchange.client),
      );
      // Only a snapshot that stored something starts the interval; an unchanged tree costs nothing.
      if (taken.status === 'saved') markTimedSnapshot(root);
    }
  } catch {
    /* Advisory: the next snapshot retries. */
  }
  process.exit(0);
}
