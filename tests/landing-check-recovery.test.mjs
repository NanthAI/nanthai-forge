// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { MAX_CONTROLLER_RECOVERIES, lostLandingCheckController } from '../dist/landing-check-recovery.js';

const lost = {
  backend: { actual: 'local' },
  runner: { pid: 2147483647, host: hostname() },
  status: 'interrupted',
};
test('only local controller loss or service-stop signals resume a durable landing', () => {
  assert.equal(lostLandingCheckController(lost, []), true);
  for (const signal of ['SIGTERM', 'SIGHUP'])
    assert.equal(
      lostLandingCheckController(
        {
          ...lost,
          status: 'cancelled',
          cancellation: { reason: 'signal', signal },
        },
        [],
      ),
      true,
    );
  const terminal = [
    { ...lost, status: 'passed' },
    { ...lost, status: 'failed' },
    { ...lost, status: 'running' },
    { ...lost, cancelRequested: true },
    { ...lost, runner: { pid: process.pid, host: hostname() } },
    { ...lost, runner: { pid: 2147483647, host: 'remote-machine' } },
    { ...lost, backend: { actual: 'modal' } },
    { ...lost, backend: { actual: 'github-actions' } },
    { ...lost, error: { code: 'DISK_LOW', message: 'Synthetic preparation error' } },
    { ...lost, cancellation: { reason: 'command' } },
    { ...lost, cancellation: { reason: 'queue' } },
    { ...lost, cancellation: { reason: 'signal', signal: 'SIGINT' } },
    { ...lost, status: 'cancelled', cancellation: { reason: 'command' } },
    { ...lost, status: 'cancelled', cancellation: { reason: 'queue' } },
    { ...lost, status: 'cancelled', cancellation: { reason: 'signal', signal: 'SIGINT' } },
    { ...lost, status: 'cancelled' },
  ];
  for (const run of terminal) assert.equal(lostLandingCheckController(run, []), false, JSON.stringify(run));
});

test('repeated controller loss on one entry stops recovering and keeps the last outcome', () => {
  const retry = { at: new Date().toISOString(), code: 'LANDING_CHECK_CONTROLLER_ENDED', runId: 'r' };
  const entry = n => ({ infrastructureRetries: Array.from({ length: n }, () => retry) });
  assert.equal(lostLandingCheckController(lost, [entry(MAX_CONTROLLER_RECOVERIES - 1), undefined]), true);
  assert.equal(lostLandingCheckController(lost, [entry(0), entry(MAX_CONTROLLER_RECOVERIES)]), false);
  const other = { infrastructureRetries: Array.from({ length: 9 }, () => ({ ...retry, code: 'OTHER' })) };
  assert.equal(lostLandingCheckController(lost, [other]), true);
});
