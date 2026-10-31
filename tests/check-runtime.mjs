// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A killed test process (timeout, CI cancel) never runs its exit handler. Each run first removes the
// private directories of earlier runs: our own prefixes, older than two hours (a live run is younger).
const ownPrefixes = ['forge-test-'];
try {
  for (const name of readdirSync(tmpdir()))
    if (ownPrefixes.some(prefix => name.startsWith(prefix))) {
      const path = join(tmpdir(), name);
      if (Date.now() - lstatSync(path).mtimeMs > 2 * 3_600_000)
        rmSync(path, { recursive: true, force: true });
    }
} catch {
  /* Sweeping is best effort; another run may be removing the same directory. */
}
const directory = mkdtempSync(join(tmpdir(), 'forge-test-check-queue-'));
process.env.FORGE_CHECK_QUEUE_DIR = directory;
// Synthetic locks held by this test process expect immediate WORK_BUSY; lock-wait tests opt in explicitly.
process.env.FORGE_WORK_LOCK_WAIT_MS = '0';
// Async landing/driver queues can yield to fixture releases; keep their bounded wait enabled.
process.env.FORGE_LANDING_LOCK_WAIT_MS = '60000';
// Tests never see the machine's saved `nforge login`: it would register account-only MCP tools.
const config = mkdtempSync(join(tmpdir(), 'forge-test-config-'));
process.env.XDG_CONFIG_HOME = config;
// Nor the real home: ~/.forge (queue, logs) and ~/.config/forge (login, metric outbox) are the owner's.
// Spawned children inherit both. src/test-isolation.ts refuses real-path writes if this file is skipped.
const home = mkdtempSync(join(tmpdir(), 'forge-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.FORGE_TEST_MODE = '1';
const cleanup = () => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
};
process.once('exit', cleanup);
// The test runner stops a timed-out file with SIGTERM, which skips 'exit'.
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    cleanup();
    process.kill(process.pid, signal);
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
