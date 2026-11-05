// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, renameSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Companion to the TAP reporter: terminal per-file observations only. A missing
 * or interrupted report supplies no reusable pass, even if the process exited 0. */
export default async function* preflightReporter(
  events: AsyncIterable<{ type: string; data: { file?: string } }>,
) {
  const passed = new Set<string>();
  const failed = new Set<string>();
  for await (const event of events) {
    if (!event.data?.file) continue;
    const location = event.data.file.startsWith('file:') ? fileURLToPath(event.data.file) : event.data.file;
    const file = relative(process.cwd(), location).replaceAll('\\', '/');
    if (event.type === 'test:pass') passed.add(file);
    if (event.type === 'test:fail') failed.add(file);
  }
  const path = process.env.FORGE_PREFLIGHT_REPORT;
  if (path) {
    writeFileSync(`${path}.tmp`, JSON.stringify([...passed].filter(file => !failed.has(file))), {
      mode: 0o600,
    });
    renameSync(`${path}.tmp`, path);
  }
  yield '';
}
