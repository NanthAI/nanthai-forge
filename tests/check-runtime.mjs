// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'forge-test-check-queue-'));
process.env.FORGE_CHECK_QUEUE_DIR = directory;
// Synthetic locks held by this test process expect immediate WORK_BUSY; lock-wait tests opt in explicitly.
process.env.FORGE_WORK_LOCK_WAIT_MS = '0';
// Async landing/driver queues can yield to fixture releases; keep their bounded wait enabled.
process.env.FORGE_LANDING_LOCK_WAIT_MS = '60000';
// Tests never see the machine's saved `nforge login`: it would register account-only MCP tools.
const config = mkdtempSync(join(tmpdir(), 'forge-test-config-'));
process.env.XDG_CONFIG_HOME = config;
process.once('exit', () => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
});

// Optional per-file wall times include module loading, test execution and teardown.
const timingFile = process.env.FORGE_TEST_TIMINGS;
const testFile = process.argv[1]?.match(/(?:^|\/)tests\/[^/]+\.test\.mjs$/)?.[0]?.replace(/^\//, '');
if (timingFile && process.env.NODE_TEST_CONTEXT && testFile) {
  const start = performance.now();
  process.once('exit', exitCode =>
    appendFileSync(
      timingFile,
      JSON.stringify({
        file: testFile,
        durationMs: performance.now() - start,
        exitCode,
      }) + '\n',
    ),
  );
}
