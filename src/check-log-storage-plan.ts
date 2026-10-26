// SPDX-License-Identifier: Apache-2.0
import { portableCheckPath, isCheckLogPath } from './check-log-policy.js';
import type { LogData } from './check-log-policy.js';
export type LogStorageSnapshot = {
  id: string;
  files: { path: string; sha256: string; size: number }[];
  data: LogData;
};
/** Shared hashes are retained if any non-log file or unexpired opted-in log needs them.
 * Representation edges include recipes, byte-tree pages and leaves. */
export function checkLogStoragePlan(
  snapshots: LogStorageSnapshot[],
  edges: Map<string, string[]> = new Map(),
  extraProtected: Iterable<string> = [],
  now = Date.now(),
) {
  const candidates = new Set<string>(),
    protectedPins = new Set(extraProtected);
  const logs: { snapshotId: string; path: string; sha256: string; size: number }[] = [];
  for (const snapshot of snapshots)
    for (const file of snapshot.files)
      if (isCheckLogPath(file.path) && !portableCheckPath(snapshot.data, file.path, now)) {
        candidates.add(file.sha256);
        logs.push({ snapshotId: snapshot.id, ...file });
      } else protectedPins.add(file.sha256);
  const close = (roots: Set<string>) => {
    for (const pin of roots) for (const child of edges.get(pin) ?? []) roots.add(child);
  };
  close(candidates);
  close(protectedPins);
  return {
    logs,
    digests: [...candidates].filter(pin => !protectedPins.has(pin)).sort(),
    shared: [...candidates].filter(pin => protectedPins.has(pin)).sort(),
    logicalBytes: logs.reduce((sum, log) => sum + log.size, 0),
  };
}
