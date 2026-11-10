// SPDX-License-Identifier: Apache-2.0
import { editTarget } from './agent-edit-target.js';
import { withExchangeProgress } from './exchange-progress.js';
import { snapshotsKept } from './lane-snapshot-hint.js';
import type { SnapshotClient, SnapshotReceipt } from './hosted-lane-snapshot.js';

/** The installed Stop hook has 5 s: stop the upload well inside it. */
const TURN_END_SNAPSHOT_MS = 3_500;

/**
 * Turn-end unsaved-work snapshot (Issue 7ac4e32f). Edits made after the last Forge command are not
 * covered by the per-command snapshot, so a turn that ends inside a Lane checkout takes one more.
 * Runs only when this checkout last saw its project keep snapshots, so a project without the
 * policy costs one local file check; an unchanged tree costs a local walk and no call. The caller
 * runs it at most once per turn (an allowed Stop) and never lets its failure reach the agent.
 */
export async function turnEndSnapshot(
  input: { cwd?: unknown },
  client: (target: { url: string; projectId: string }) => Promise<SnapshotClient>,
): Promise<SnapshotReceipt | null> {
  if (typeof input.cwd !== 'string' || !input.cwd) return null;
  const target = editTarget(`${input.cwd}/.`);
  if (!target?.url || !snapshotsKept(target.root)) return null;
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), TURN_END_SNAPSHOT_MS);
  timer.unref();
  try {
    const { snapshotLaneCheckout } = await import('./hosted-lane-snapshot.js');
    const exchange = await client({ url: target.url, projectId: target.project });
    return await withExchangeProgress({ signal: cancel.signal }, () =>
      snapshotLaneCheckout(target.root, target.project, exchange),
    );
  } finally {
    clearTimeout(timer);
  }
}
