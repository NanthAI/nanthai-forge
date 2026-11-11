// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from 'node:fs';
import { installTestTemp } from '../scripts/test-temp.mjs';
import { installDefaultR2 } from './default-r2.mjs';
import { checkReturns, rawHandler, returnsCheck } from './convex-args.mjs';
// The file supervisor owns the outer root across SIGKILL/timeouts. Direct test runs
// still clean their private root on exit/signals and fail on unowned fixture leaks.
const { queue: directory, config, home, state } = installTestTemp();
process.env.FORGE_CHECK_QUEUE_DIR = directory;
// Synthetic locks held by this test process expect immediate WORK_BUSY; lock-wait tests opt in explicitly.
process.env.FORGE_WORK_LOCK_WAIT_MS = '0';
// Async landing/driver queues can yield to fixture releases; keep their bounded wait enabled.
process.env.FORGE_LANDING_LOCK_WAIT_MS = '60000';
// Tests never see the machine's saved `nforge login`: it would register account-only MCP tools.
process.env.XDG_CONFIG_HOME = config;
process.env.XDG_STATE_HOME = state;
// Nor the real home: ~/.forge (queue, logs) and ~/.config/forge (login, metric outbox) are the owner's.
// Spawned children inherit both. src/test-isolation.ts refuses real-path writes if this file is skipped.
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.FORGE_TEST_MODE = '1';
// Bytes always go to R2 (there is no Convex byte mode): every test process gets an in-memory bucket.
installDefaultR2();
// Convex validates every return value against the declared `returns` validator and fails the call
// on a mismatch. Tests that call `fn._handler` directly bypass any fixture, so Convex's registration
// (`func._handler = handler`) lands here and stores a handler that checks its result (Issue b7c8e4dd).
// Fixtures that check under the function's name call the unchecked handler via `rawHandler`.
Object.defineProperty(Function.prototype, '_handler', {
  configurable: true,
  set(handler) {
    const fn = this;
    function checked(...args) {
      const result = handler.apply(this, args);
      // Without a declared `returns` the exact result (sync value, same promise) passes through.
      if (typeof fn.exportReturns !== 'function' || !returnsCheck(fn)) return result;
      const returned = value => (checkReturns(fn, value, '_handler'), value);
      return typeof result?.then === 'function' ? result.then(returned) : returned(result);
    }
    for (const [key, value] of [
      ['_handler', checked],
      [rawHandler, handler],
    ])
      Object.defineProperty(fn, key, { value, writable: true, configurable: true, enumerable: true });
  },
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
