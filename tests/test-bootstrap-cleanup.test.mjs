// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const bootstrap = fileURLToPath(new URL('./check-runtime.mjs', import.meta.url));
const env = temp => ({ ...process.env, TMPDIR: temp, NODE_TEST_CONTEXT: '' });
const scratch = t => {
  const temp = mkdtempSync(join(tmpdir(), 'forge-bootstrap-check-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return temp;
};
const leftovers = temp => readdirSync(temp).filter(name => name.startsWith('forge-test-'));

test('the test bootstrap removes its private directories when the process exits', t => {
  const temp = scratch(t);
  const run = spawnSync(process.execPath, ['--import', bootstrap, '-e', ''], { env: env(temp) });
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(leftovers(temp), []);
});

test('the test bootstrap removes its private directories when the runner stops it with SIGTERM', async t => {
  const temp = scratch(t);
  const child = spawn(
    process.execPath,
    ['--import', bootstrap, '-e', "console.log('ready'); setInterval(() => {}, 1000)"],
    { env: env(temp), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await once(child.stdout, 'data');
  assert.equal(leftovers(temp).length, 3, 'check queue, config and home directories exist while it runs');
  child.kill('SIGTERM');
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGTERM');
  assert.deepEqual(leftovers(temp), []);
});

test('the test bootstrap sweeps its own stale directories, leaving young ones and other names alone', t => {
  const temp = scratch(t);
  const make = (name, hours) => {
    const path = join(temp, name);
    mkdirSync(join(path, 'inner'), { recursive: true });
    const when = new Date(Date.now() - hours * 3_600_000);
    utimesSync(path, when, when);
    return name;
  };
  const stale = make('forge-test-config-stale', 5),
    young = make('forge-test-home-young', 0.5),
    foreign = make('forge-exchange-stale', 5);
  const run = spawnSync(process.execPath, ['--import', bootstrap, '-e', ''], { env: env(temp) });
  assert.equal(run.status, 0, String(run.stderr));
  assert.deepEqual(readdirSync(temp).sort(), [foreign, young].sort());
  assert(!readdirSync(temp).includes(stale));
});
