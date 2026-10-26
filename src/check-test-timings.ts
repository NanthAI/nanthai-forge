// SPDX-License-Identifier: Apache-2.0
import { runDetails } from './work-detail-store.js';
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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

/** Keep memory independent of retained log size, including malformed/truncated lines. */
function* logLines(path: string) {
  const fd = openSync(path, 'r'),
    decoder = new StringDecoder('utf8'),
    buffer = Buffer.alloc(65536);
  let pending = '',
    dropping = false,
    size: number;
  try {
    while ((size = readSync(fd, buffer, 0, buffer.length, null))) {
      const parts = (pending + decoder.write(buffer.subarray(0, size))).split('\n');
      pending = parts.pop()!;
      for (const line of parts) {
        if (!dropping && line.length <= 1024 * 1024) yield line;
        dropping = false;
      }
      if (pending.length > 1024 * 1024) {
        pending = '';
        dropping = true;
      }
    }
    // No newline means the machine report may be truncated: do not learn from it.
  } finally {
    closeSync(fd);
  }
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
    const shards = join(directory, 'shards');
    const logs = existsSync(shards)
      ? readdirSync(shards)
          .map(name => ({ name, match: /^(\d+)(?:\.attempt-(\d+))?\.log$/.exec(name) }))
          .filter(item => item.match)
          .sort(
            (a, b) =>
              Number(a.match![2] ?? 1) - Number(b.match![2] ?? 1) ||
              Number(a.match![1]) - Number(b.match![1]),
          )
          .map(item => join(shards, item.name))
      : [join(directory, 'stdout.log')];
    for (const log of logs) {
      if (!existsSync(log)) continue;
      for (const line of logLines(log)) {
        const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
        if (!clean.startsWith('__FORGE_TESTS__')) continue;
        try {
          observe(JSON.parse(clean.slice('__FORGE_TESTS__'.length)));
        } catch {
          /* Truncated report. */
        }
      }
    }
    // Modal's collector retains machine reports in execution results instead of stdout.
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
