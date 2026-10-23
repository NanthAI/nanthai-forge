// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { join } from 'node:path';
import { progressJson } from './land-check-progress.js';
import { readLandingProgress } from './land-progress.js';
import type { LandEntry } from './land-journal.js';
import type { WorkStore } from './work-store.js';

type Progress = ReturnType<typeof readLandingProgress>;
export function landingProgressLine(laneId: string, phases: Progress) {
  const queue = phases.queue;
  const counts = Object.entries(phases.progress ?? {}).map(
    ([kind, count]) => `${kind} ${count.done}/${count.total}`,
  );
  return `${laneId.slice(0, 8)}: ${phases.current}${phases.outcome && phases.outcome !== 'accepted' ? ` (${phases.outcome})` : ''}${queue ? ` · position ${queue.position} of ${queue.total} · waiting on: ${queue.waitingOn}` : phases.waitingOn ? ` · waiting on: ${phases.waitingOn}` : ''}${counts.length ? ` · ${counts.join(' · ')}` : ''}${phases.eta ? ` · ETA ~${Math.ceil(phases.eta.remainingMs / 1000)}s (estimate)` : ''}`;
}
/** ETA drift and elapsed time do not cause output; phase/progress/queue changes do. */
export function changeOnlyLandingReporter(write: (line: string) => void) {
  const seen = new Map<string, string>();
  return (laneId: string, phases: Progress) => {
    const key = JSON.stringify({
      current: phases.current,
      queue: phases.queue,
      progress: phases.progress,
      waitingOn: phases.waitingOn,
      outcome: phases.outcome,
    });
    if (seen.get(laneId) === key) return;
    seen.set(laneId, key);
    write(landingProgressLine(laneId, phases) + '\n');
  };
}
export function landProgressReporter(store: WorkStore, operationId: string) {
  const report = changeOnlyLandingReporter(line => process.stderr.write(line));
  return () => {
    const journal = progressJson<{ entries: LandEntry[] }>(
      join(store.directory, 'agent-land', `${operationId}.json`),
    );
    if (!journal) return false;
    try {
      store.observing(() => {
        for (const entry of journal.entries) {
          const phases = readLandingProgress(store, entry.command.operationId, entry);
          for (const pin of entry.inputs) report(pin.laneId, phases);
        }
      });
      return true;
    } catch (error) {
      if (error instanceof ForgeError && ['SOURCE_CHANGED', 'WORK_STALE'].includes(error.code)) return false;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
}
