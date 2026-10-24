import { readLandingProgress } from './land-progress.js';
import { phaseSummary } from './land-phases.js';
// SPDX-License-Identifier: Apache-2.0
import { landSubmissions } from './landing-submission-read.js';
import { submissionLine } from './landing-submission.js';
import type { LandJournal } from './land-journal.js';
import type { LandCommand } from './land-schema.js';
import type { WorkStore } from './work-store.js';
export function landReceipt(store: WorkStore, command: LandCommand, journal: LandJournal, wait?: boolean) {
  const replay = wait === false ? { ...command, wait: false } : command;
  const entries = journal.state.entries.map(entry => {
    const submissions = landSubmissions(store, entry);
    const phases =
      submissions[0]?.phases ??
      readLandingProgress(store, entry.command.operationId, entry, undefined, false);
    return {
      operationId: entry.command.operationId,
      message: entry.command.message,
      inputs: entry.inputs,
      status: String(entry.result?.status ?? 'waiting'),
      ...(entry.result ?? { status: 'waiting' }),
      phases,
      submissions,
    };
  });
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const status = String(entry.status);
    counts[status] = (counts[status] ?? 0) + entry.inputs.length;
  }
  return {
    revision: store.revision(),
    result: {
      operationId: command.operationId,
      complete: entries.every(entry => entry.submissions.every(submission => submission.complete)),
      terminal: entries.every(entry => entry.submissions.every(submission => submission.terminal)),
      summary: entries.flatMap(entry =>
        entry.submissions.map(
          submission => `${submission.laneId.slice(0, 8)}: ${submissionLine(submission)}`,
        ),
      ),
      table: [
        'Lane\tHead\tResult\tPhase durations',
        ...entries.flatMap(entry =>
          entry.submissions.map(
            item =>
              `${item.laneId}\t${item.head}\t${item.state}${item.cause ? ` (${item.cause})` : ''}\t${phaseSummary(entry.phases)}`,
          ),
        ),
      ].join('\n'),
      counts,
      entries,
      replay: {
        command: replay,
        shell: `nforge agent '${store.root.replaceAll("'", "'\\''")}' land '${JSON.stringify(replay).replaceAll("'", "'\\''")}'`,
      },
    },
  };
}
