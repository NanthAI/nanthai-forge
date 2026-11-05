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
    assert.deepEqual(args.slice(2), ['--watcher-close-health', '--private-root']);
    assert.equal(options.timeout, 7000);
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
