// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { filesystemEventHealth } from '../dist/filesystem-event-health.js';

const healthy = {
  ok: true,
  latencyMs: 8,
  fseventsdRssMb: 40,
  fseventsdCpuPercent: 1,
  reason: null,
  attempts: [{ latencyMs: 8, reason: null }],
};
test('native diagnostic adapter executes installed code with a finite outer envelope and no target code', () => {
  let calls = 0;
  const health = filesystemEventHealth('/synthetic/target', (executable, args, options) => {
    calls++;
    assert.equal(executable, process.execPath);
    assert.ok(args[0].endsWith('/scripts/filesystem-event-health.mjs'));
    assert.equal(args[1], '/synthetic/target');
    assert.deepEqual(args.slice(2, 4), ['--watcher-close-health', '--private-root']);
    // Each run probes in its own folder (48835eea), so a concurrent run's cleanup never removes it.
    assert.match(args[4], /^--probe-id=[0-9a-f-]{36}$/);
    assert.equal(args.length, 5);
    // Above the probe's own budget (3 x 2 s attempts + 500 ms stats), so it finishes its cleanup (48835eea).
    assert.equal(options.timeout, 9000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 16384);
    return { status: 0, stdout: JSON.stringify(healthy) };
  });
  assert.deepEqual(health, healthy);
  assert.equal(calls, 1);
});

for (const result of [
  { stdout: '', error: new Error('ETIMEDOUT'), signal: 'SIGKILL' },
  { stdout: 'not JSON', status: 1 },
  { stdout: '{"ok":true}', status: 0 },
])
  test(`unavailable native diagnostic is typed and finite (${result.error ? 'timeout' : result.stdout})`, () => {
    const health = filesystemEventHealth('/synthetic', () => result);
    assert.equal(health.ok, false);
    assert.match(health.reason, /filesystem diagnostic unavailable/);
    assert.deepEqual(health.attempts, []);
  });
