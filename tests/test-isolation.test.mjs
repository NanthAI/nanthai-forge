// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import './check-runtime.mjs';
import { writeAuth, authFile } from '../dist/auth-store.js';
import { CheckQueue } from '../dist/check-queue.js';
import { writeCallerReceipts } from '../dist/hosted-metric-outbox.js';
import { recordFailure } from '../dist/system-errors.js';
import { refuseRealUserState } from '../dist/test-isolation.js';

// A fake "real" account home: the guard is exercised without ever pointing at the owner's files.
const fakeAccount = mkdtempSync(join(tmpdir(), 'forge-fake-account-'));
const asRealAccount = (t, env = {}) => {
  const old = Object.fromEntries(
    ['FORGE_TEST_ACCOUNT_HOME', 'XDG_CONFIG_HOME', 'HOME', 'FORGE_CHECK_QUEUE_DIR', ...Object.keys(env)].map(
      key => [key, process.env[key]],
    ),
  );
  process.env.FORGE_TEST_ACCOUNT_HOME = fakeAccount;
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
};
test.after(() => rmSync(fakeAccount, { recursive: true, force: true }));

test('the test bootstrap points XDG_CONFIG_HOME, HOME and the queue away from the real account', () => {
  const real = userInfo().homedir;
  for (const value of [process.env.XDG_CONFIG_HOME, process.env.HOME, process.env.FORGE_CHECK_QUEUE_DIR])
    assert.ok(value && value.startsWith(tmpdir()) && !value.startsWith(join(real, '.config')), value);
  assert.equal(homedir(), process.env.HOME);
  assert.equal(authFile().startsWith(process.env.XDG_CONFIG_HOME), true);
  // Spawned children inherit the same isolation without any per-test setup.
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.XDG_CONFIG_HOME)'], {
    env: process.env,
    encoding: 'utf8',
  });
  assert.equal(child.stdout, process.env.XDG_CONFIG_HOME);
});

test('auth-store refuses to write the real user login while a test runs', t => {
  asRealAccount(t, { XDG_CONFIG_HOME: join(fakeAccount, '.config') });
  assert.throws(() => writeAuth({ deployments: {} }), { code: 'TEST_REAL_USER_STATE' });
  assert.equal(existsSync(join(fakeAccount, '.config')), false);
  // Unset XDG falls back to <home>/.config: also refused.
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = fakeAccount;
  assert.throws(() => writeAuth({ deployments: {} }), { code: 'TEST_REAL_USER_STATE' });
  assert.equal(existsSync(join(fakeAccount, '.config')), false);
});

test('auth-store writes normally outside the real user path', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-auth-ok-'));
  asRealAccount(t, { XDG_CONFIG_HOME: directory });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeAuth({ deployments: {} });
  assert.equal(existsSync(join(directory, 'forge', 'auth.json')), true);
});

test('metric outbox, check queue and diagnostics refuse real user paths from tests', t => {
  asRealAccount(t);
  const outbox = join(fakeAccount, '.config', 'forge', 'metric-outbox', 'x');
  writeCallerReceipts(outbox, [{}]);
  assert.equal(existsSync(outbox), false);
  const queue = join(fakeAccount, '.forge', 'check-queue');
  assert.throws(() => new CheckQueue(queue), { code: 'TEST_REAL_USER_STATE' });
  assert.equal(existsSync(queue), false);
  process.env.HOME = fakeAccount;
  const failure = recordFailure(new Error('synthetic'));
  assert.equal(existsSync(join(fakeAccount, '.forge', 'logs')), false);
  assert.ok(!failure.diagnostics || failure.diagnostics.startsWith(tmpdir()));
});

test('the guard is inert outside test processes and for unrelated paths', t => {
  asRealAccount(t);
  refuseRealUserState(join(fakeAccount, 'elsewhere'), 'x');
  refuseRealUserState(join(fakeAccount, '.config', 'other'), 'x');
  mkdirSync(join(fakeAccount, '.forge'), { recursive: true });
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { refuseRealUserState } from ${JSON.stringify(new URL('../dist/test-isolation.js', import.meta.url).href)};
refuseRealUserState(${JSON.stringify(join(fakeAccount, '.forge', 'logs'))}, 'x'); process.stdout.write('ok');`,
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !['NODE_TEST_CONTEXT', 'FORGE_TEST_MODE', 'FORGE_TEST_ACCOUNT_HOME'].includes(key),
        ),
      ),
      encoding: 'utf8',
    },
  );
  assert.equal(child.stdout, 'ok');
});
