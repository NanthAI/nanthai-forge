// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deployWithRetry } from '../site/deploy/retry.mjs';

function apiError(...rows) {
  return { status: 1, stderr: ['┌ APIError', ...rows.map(row => `│ ${row}`), '└', ''].join('\n') };
}

async function deploy(...results) {
  const delays = [];
  const logs = [];
  const status = await deployWithRetry(
    () => {
      assert(results.length, 'unexpected upload attempt');
      return results.shift();
    },
    {
      wait: ms => delays.push(ms),
      log: line => logs.push(line),
    },
  );
  return { status, delays, logs, remaining: results.length };
}

const uploaded = { status: 0, stderr: '' };
// Stderr captured with a pipe from cf 1.0.0-beta.17, with synthetic responses to the Worker versions POST.
const unavailable = {
  status: 1,
  stderr: `
┌ APIError
│ A request to the Cloudflare API (/accounts/<fixture>/workers/scripts/fixture-worker/versions) failed.
│ 503 Service Unavailable
└
`,
};
const uploadError = {
  status: 1,
  stderr: `
┌ APIError
│ [10013] An unknown error has occurred. [code: 10013]
│ 500 Internal Server Error
└
`,
};
const forbidden = {
  status: 1,
  stderr: `
┌ APIError
│ A request to the Cloudflare API (/accounts/<fixture>/workers/scripts/fixture-worker/versions) failed.
│ 403 Forbidden
└

→ Check your API token permissions
`,
};

test('the deploy recovers after a Cloudflare HTTP 5xx and logs the next attempt and status', async () => {
  assert.deepEqual(await deploy(unavailable, uploaded), {
    status: 0,
    delays: [30_000],
    logs: ['Cloudflare deploy attempt 2/3 after HTTP 503'],
    remaining: 0,
  });
});

test('the deploy returns the failure after three Cloudflare HTTP 5xx responses', async () => {
  assert.deepEqual(await deploy(uploadError, unavailable, uploadError), {
    status: 1,
    delays: [30_000, 30_000],
    logs: ['Cloudflare deploy attempt 2/3 after API 10013', 'Cloudflare deploy attempt 3/3 after HTTP 503'],
    remaining: 0,
  });
});

test('Cloudflare API error 10013 retries even when cf omits the HTTP status', async () => {
  const workerUploadError = apiError('[10013] An unknown error has occurred. [code: 10013]');
  assert.deepEqual(await deploy(workerUploadError, uploaded), {
    status: 0,
    delays: [30_000],
    logs: ['Cloudflare deploy attempt 2/3 after API 10013'],
    remaining: 0,
  });
});

test('HTTP 4xx, auth and config failures end the deploy on its first attempt', async () => {
  const failures = [
    forbidden,
    apiError('[10013] An unknown error has occurred. [code: 10013]', '429 Too Many Requests'),
    { status: 2, stderr: '┌ Error\n│ Missing Cloudflare API token\n└\n' },
    { status: 3, stderr: '┌ Error\n│ Invalid configuration: HTTP 503 is not a valid fallback\n└\n' },
  ];
  for (const failure of failures) {
    assert.deepEqual(await deploy(failure), {
      status: failure.status,
      delays: [],
      logs: [],
      remaining: 0,
    });
  }
});

test('the deploy launcher forwards a nonretryable Cloudflare diagnostic and preserves the exit status', () => {
  const launcher = fileURLToPath(new URL('../site/deploy/retry.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      launcher,
      process.execPath,
      '-e',
      'process.stderr.write(process.argv[1]); process.exitCode = 7',
      forbidden.stderr,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 7);
  assert.equal(result.stderr, forbidden.stderr);
});
