// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { writeFileSync, renameSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

type ReportEvent = {
  type: string;
  data: {
    file?: string;
    name?: string;
    nesting?: number;
    skip?: string | boolean;
    details?: { duration_ms?: number };
  };
};
/** The per-file limit preflight sets for this run, in milliseconds (Item 168e4ed8). */
export const FILE_TIMEOUT_ENV = 'FORGE_PREFLIGHT_FILE_TIMEOUT_MS';

/** Companion to the TAP reporter: terminal per-file observations only. A missing
 * or interrupted report supplies no reusable pass, even if the process exited 0.
 * `ms` sums each file's top-level test durations, the cost the next run plans with. `skipped` names
 * each file with a skipped test and the first skip's reason: a skip proves nothing about the code. */
export default async function* preflightReporter(events: AsyncIterable<ReportEvent>) {
  const passed = new Set<string>();
  const failed = new Set<string>();
  const ms: Record<string, number> = {};
  const skipped: Record<string, string> = {};
  const timedOut: { file: string; seconds: number }[] = [];
  const write = () => {
    const path = process.env.FORGE_PREFLIGHT_REPORT;
    if (!path) return;
    writeFileSync(
      `${path}.tmp`,
      JSON.stringify({
        passed: [...passed].filter(file => !failed.has(file)),
        failed: [...failed],
        ms,
        skipped,
        ...(timedOut.length ? { timedOut } : {}),
      }),
      { mode: 0o600 },
    );
    renameSync(`${path}.tmp`, path);
  };
  // A file still running past its limit (a fixture that never resolves) is named and stopped: the
  // runner's SIGTERM ends its file process, and preflight then kills the rest of the process group,
  // so a hung test never holds a heavy slot past the budget. Node's own --test-timeout cancels a
  // test but leaves a file with an open handle running.
  const limit = Number(process.env[FILE_TIMEOUT_ENV]);
  let running: { file: string; since: number } | undefined;
  const timer =
    Number.isFinite(limit) && limit > 0
      ? setInterval(
          () => {
            if (!running || Date.now() - running.since <= limit) return;
            clearInterval(timer);
            timedOut.push({ file: running.file, seconds: Math.round((Date.now() - running.since) / 1000) });
            failed.add(running.file);
            write();
            process.kill(process.pid, 'SIGTERM');
          },
          Math.min(1000, Math.max(50, limit / 4)),
        )
      : undefined;
  timer?.unref();
  for await (const event of events) {
    if (!event.data?.file) continue;
    const location = event.data.file.startsWith('file:') ? fileURLToPath(event.data.file) : event.data.file;
    const file = relative(process.cwd(), location).replaceAll('\\', '/');
    // The file-level test carries the file's own path as its name: it starts at dequeue, ends at complete.
    const fileLevel = !event.data.nesting && (event.data.name === file || event.data.name === location);
    if (fileLevel && event.type === 'test:dequeue') running = { file, since: Date.now() };
    if (fileLevel && event.type === 'test:complete' && running?.file === file) running = undefined;
    if (event.type === 'test:pass') passed.add(file);
    if (event.type === 'test:pass' && event.data.skip !== undefined && event.data.skip !== false)
      skipped[file] ??= typeof event.data.skip === 'string' ? event.data.skip.slice(0, 200) : 'skipped';
    if (event.type === 'test:fail') failed.add(file);
    if ((event.type === 'test:pass' || event.type === 'test:fail') && !event.data.nesting)
      ms[file] = (ms[file] ?? 0) + Math.max(0, event.data.details?.duration_ms ?? 0);
  }
  if (timer) clearInterval(timer);
  write();
  yield '';
}
