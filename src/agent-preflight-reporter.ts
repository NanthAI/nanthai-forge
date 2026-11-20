// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, renameSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

type ReportEvent = {
  type: string;
  data: { file?: string; nesting?: number; skip?: string | boolean; details?: { duration_ms?: number } };
};

/** Companion to the TAP reporter: terminal per-file observations only. A missing
 * or interrupted report supplies no reusable pass, even if the process exited 0.
 * `ms` sums each file's top-level test durations, the cost the next run plans with. `skipped` names
 * each file with a skipped test and the first skip's reason: a skip proves nothing about the code. */
export default async function* preflightReporter(events: AsyncIterable<ReportEvent>) {
  const passed = new Set<string>();
  const failed = new Set<string>();
  const ms: Record<string, number> = {};
  const skipped: Record<string, string> = {};
  for await (const event of events) {
    if (!event.data?.file) continue;
    const location = event.data.file.startsWith('file:') ? fileURLToPath(event.data.file) : event.data.file;
    const file = relative(process.cwd(), location).replaceAll('\\', '/');
    if (event.type === 'test:pass') passed.add(file);
    if (event.type === 'test:pass' && event.data.skip !== undefined && event.data.skip !== false)
      skipped[file] ??= typeof event.data.skip === 'string' ? event.data.skip.slice(0, 200) : 'skipped';
    if (event.type === 'test:fail') failed.add(file);
    if ((event.type === 'test:pass' || event.type === 'test:fail') && !event.data.nesting)
      ms[file] = (ms[file] ?? 0) + Math.max(0, event.data.details?.duration_ms ?? 0);
  }
  const path = process.env.FORGE_PREFLIGHT_REPORT;
  if (path) {
    writeFileSync(
      `${path}.tmp`,
      JSON.stringify({
        passed: [...passed].filter(file => !failed.has(file)),
        failed: [...failed],
        ms,
        skipped,
      }),
      { mode: 0o600 },
    );
    renameSync(`${path}.tmp`, path);
  }
  yield '';
}
