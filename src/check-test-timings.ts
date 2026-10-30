// SPDX-License-Identifier: Apache-2.0
import { checkEvidenceLines } from './check-compact-output.js';
import { runDetails } from './work-detail-store.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { updateTimingHistory } from '../scripts/test-shards.mjs';
import { readTimingHistory } from '../scripts/test-timings-file.mjs';
import { durableReplace, syncDirectory } from './native-durability.js';
import { NativeSource } from './native-source.js';
import { workLocked } from './work-lock.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Under the timing lock, settle a previous writer before preparing any newer sample.
 * This closes the history/marker crash gap even after the bounded run ledger rolls over. */
function publishPending(store: WorkStore) {
  const path = join(store.directory, 'test-timings-pending.json');
  if (!existsSync(path)) return;
  const pending = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[0-9a-f-]{36}$/i.test(pending.runId)) throw new Error('Invalid pending timing run.');
  durableReplace(join(store.directory, 'test-timings.json'), JSON.stringify(pending.history));
  durableReplace(join(store.directory, `check-${pending.runId}`, 'test-timings-recorded'), pending.runId);
  unlinkSync(path);
  syncDirectory(store.directory);
}

/** Called on terminal receipt reconciliation, never while a shard is still running.
 * History is advisory; failure to retain it cannot change check evidence or routing. */
export function recordCheckTimings(store: WorkStore, run: CheckRun, directory: string): boolean {
  if (!store.native || !['passed', 'failed'].includes(run.status) || !run.checkSelection) return false;
  const marker = join(directory, 'test-timings-recorded');
  if (existsSync(marker)) return true;
  try {
    const selected = new Set(runDetails(store, run).checkSelection!.tests),
      durations: Record<string, number> = {};
    const observe = (report: { file?: unknown; complete?: unknown; durationMs?: unknown }) => {
      if (
        typeof report?.file === 'string' &&
        selected.has(report.file) &&
        report.complete === true &&
        typeof report.durationMs === 'number' &&
        Number.isFinite(report.durationMs) &&
        report.durationMs > 0
      )
        durations[report.file] = report.durationMs;
    };
    for (const line of checkEvidenceLines(directory, true)) {
      const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
      if (!clean.startsWith('__FORGE_TESTS__')) continue;
      try {
        observe(JSON.parse(clean.slice('__FORGE_TESTS__'.length)));
      } catch {
        /* Truncated report. */
      }
    }
    // Retained shard indexes store machine reports in execution results instead of stdout.
    const executionsPath = join(directory, 'modal-shard-logs.json');
    if (existsSync(executionsPath)) {
      const executions = JSON.parse(readFileSync(executionsPath, 'utf8'));
      for (const execution of executions.sort(
        (a: { attempt: number }, b: { attempt: number }) => a.attempt - b.attempt,
      ))
        for (const report of Object.values(execution.tests ?? {}))
          observe(report as Parameters<typeof observe>[0]);
    }
    const files = new NativeSource(store.root).state(run.head).files.map(file => file.path);
    workLocked(
      join(store.directory, 'test-timings.lock'),
      () => {
        publishPending(store);
        if (existsSync(marker)) return;
        const path = join(store.directory, 'test-timings.json');
        const history = updateTimingHistory(readTimingHistory(path), {
          runId: run.id,
          endedAt: run.endedAt!,
          files,
          durations,
        });
        durableReplace(
          join(store.directory, 'test-timings-pending.json'),
          JSON.stringify({ runId: run.id, history }),
        );
        publishPending(store);
      },
      { operation: 'record test timings' },
    );
    return true;
  } catch {
    return false;
  }
}
