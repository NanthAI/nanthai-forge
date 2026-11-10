// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

test('signal and likely-OOM check failures do not become confirmed transient infrastructure', async () => {
  const { diagnosticStatus, diagnosticCause } = await import('../dist/landing-diagnosis.js');
  for (const run of [
    { status: 'failed', exitCode: 137 },
    { status: 'failed', exitCode: null, signal: 'SIGKILL' },
    {
      status: 'failed',
      exitCode: 1,
      backend: { actual: 'github-actions' },
      error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' },
    },
  ]) {
    assert.equal(diagnosticStatus(run), 'failed');
    assert.equal(diagnosticCause(run), 'check-failed');
  }
});
