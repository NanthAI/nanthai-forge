// SPDX-License-Identifier: Apache-2.0
import { after } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { socketDirectory } from '../../dist/socket-directory.js';

const made = [];
// One file-level hook: detached workers can still reach a fixture's socket while that test's own
// cleanup drains them, so the directory goes only after every test in the file has finished.
after(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A Unix socket path that fits the macOS 104-byte limit even when TMPDIR is nested deeply (local
 * preflight). Removed when the test file ends. */
export function shortSocketPath(name = 'gate') {
  const directory = socketDirectory('forge-sock-', name);
  made.push(directory);
  return join(directory, name);
}
