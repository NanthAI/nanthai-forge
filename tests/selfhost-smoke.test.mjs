// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

test('smoke entrypoint reports sanitized configuration failures and retains private diagnostics', t => {
  const result = spawnSync(process.execPath, ['scripts/selfhost-smoke.mjs'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH, GITHUB_TOKEN: 'synthetic-private-token', FORGE_SMOKE_REF: 'invalid' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed during configuration/);
  assert.match(result.stderr, /Command: in-process smoke check/);
  assert.match(result.stderr, /Provide the ephemeral GitHub read token/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-token|CONVEX_SELF_HOSTED_ADMIN_KEY=/);
  const directory = /Private diagnostic data retained at (.+); credentials/.exec(result.stderr)?.[1];
  assert(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'failure.log')).mode & 0o777, 0o600);
});
