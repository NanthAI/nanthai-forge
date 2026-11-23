// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeInstall } from '../dist/dependency-seal.js';
import { withCliRuntimeLock, cliProcessIdentity } from '../dist/cli-launcher.js';

const module = pathToFileURL(fileURLToPath(new URL('../dist/cli-launcher.js', import.meta.url))).href;
const DEAD = 2147483647;
const deadOwner = () => JSON.stringify({ pid: DEAD, host: hostname(), startTime: 'dead' });
const OLD = new Date('2026-01-01T00:00:00Z');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-runtime-lock-'));
  t.after(() => removeInstall(directory));
  const installation = join(directory, 'forge-cli');
  mkdirSync(installation, { recursive: true });
  return {
    installation,
    lock: join(installation, 'runtime.lock'),
    fence: join(installation, 'runtime.lock-recovery'),
    names: () => readdirSync(installation).sort(),
  };
}

test('incident replay: a dead holder and a recovery fence left by a killed process do not block the next call', t => {
  const f = fixture(t);
  writeFileSync(f.lock, deadOwner());
  // The killed process had created the fence and never wrote an owner into it.
  mkdirSync(f.fence);
  utimesSync(f.fence, OLD, OLD);
  assert.equal(
    withCliRuntimeLock(f.installation, () => 'recovered'),
    'recovered',
  );
  assert.deepEqual(f.names(), []);
});

test('a fence whose recorded owner is dead is recovered at once, however recent', t => {
  const f = fixture(t);
  writeFileSync(f.lock, deadOwner());
  mkdirSync(f.fence);
  writeFileSync(join(f.fence, 'owner'), deadOwner());
  assert.equal(
    withCliRuntimeLock(f.installation, () => 'recovered'),
    'recovered',
  );
  assert.deepEqual(f.names(), []);
});

test('a fresh fence with no owner yet is a recovery in progress and is respected', t => {
  const f = fixture(t);
  writeFileSync(f.lock, deadOwner());
  mkdirSync(f.fence);
  assert.throws(() => withCliRuntimeLock(f.installation, () => assert.fail()), {
    code: 'CLI_RUNTIME_BUSY',
  });
  assert.ok(existsSync(f.fence), 'the other recoverer keeps its fence');
  assert.ok(existsSync(f.lock));
});

test('a fence owned by a live process is respected', t => {
  const f = fixture(t);
  writeFileSync(f.lock, deadOwner());
  mkdirSync(f.fence);
  writeFileSync(
    join(f.fence, 'owner'),
    JSON.stringify({ ...cliProcessIdentity(), host: hostname(), operation: 'CLI runtime' }),
  );
  assert.throws(() => withCliRuntimeLock(f.installation, () => assert.fail()), {
    code: 'CLI_RUNTIME_BUSY',
  });
  assert.ok(existsSync(f.fence));
});

test('CLI_RUNTIME_BUSY names the holder pid and whether it is running, with a step that needs no lock', async t => {
  const f = fixture(t);
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { withCliRuntimeLock } from ${JSON.stringify(module)};
withCliRuntimeLock(${JSON.stringify(f.installation)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); }); // test-signal: allow child holds the lock for a bounded time
`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => holder.kill());
  await new Promise(done => holder.stdout.once('data', done));
  assert.throws(
    () => withCliRuntimeLock(f.installation, () => assert.fail()),
    error =>
      error.code === 'CLI_RUNTIME_BUSY' &&
      error.message.includes(`pid ${holder.pid} is running`) &&
      error.message.includes(`kill ${holder.pid}`) &&
      !error.message.includes('nforge update'),
  );
  // A dead holder that could not be recovered (another recoverer is mid-flight) says so.
  holder.kill();
  await new Promise(done => holder.once('exit', done));
  mkdirSync(f.fence);
  assert.throws(
    () => withCliRuntimeLock(f.installation, () => assert.fail()),
    error =>
      error.code === 'CLI_RUNTIME_BUSY' &&
      error.message.includes(`pid ${holder.pid}, which is not running`) &&
      error.message.includes('retry'),
  );
});

test('pending files of dead pids are removed when a call meets contention; live ones stay', t => {
  const f = fixture(t);
  writeFileSync(f.lock, deadOwner());
  const stale = join(f.installation, `runtime.lock-${DEAD}-aaaaaaaa.pending`),
    torn = join(f.installation, 'runtime.lock-4242-bbbbbbbb.pending'),
    live = join(f.installation, `runtime.lock-${process.pid}-cccccccc.pending`),
    other = join(f.installation, 'runtime.lock-notes.txt');
  writeFileSync(stale, deadOwner());
  writeFileSync(torn, '');
  utimesSync(torn, OLD, OLD);
  writeFileSync(
    live,
    JSON.stringify({ ...cliProcessIdentity(), host: hostname(), operation: 'CLI runtime' }),
  );
  writeFileSync(other, 'keep');
  withCliRuntimeLock(f.installation, () => {});
  assert.deepEqual(f.names(), [live, other].map(path => path.slice(f.installation.length + 1)).sort());
});

test('callers never both hold the lock, even while recovering a dead holder and a stale fence', async t => {
  const f = fixture(t);
  writeFileSync(f.lock, deadOwner());
  mkdirSync(f.fence);
  utimesSync(f.fence, OLD, OLD);
  const inside = join(f.installation, 'inside');
  const script = `import { withCliRuntimeLock } from ${JSON.stringify(module)};
import { openSync, closeSync, rmSync } from 'node:fs';
for (let i = 0; i < 5; i++)
  withCliRuntimeLock(${JSON.stringify(f.installation)}, () => {
    closeSync(openSync(${JSON.stringify(inside)}, 'wx'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // test-signal: allow child keeps the critical section open so a second holder would collide
    rmSync(${JSON.stringify(inside)});
  }, 30000);`;
  const run = () =>
    new Promise(done => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => (stderr += chunk));
      child.once('exit', status => done({ status, stderr }));
    });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(
    results.map(({ status }) => status),
    [0, 0, 0, 0],
    results.map(({ stderr }) => stderr).join('\n'),
  );
  assert.deepEqual(f.names(), []);
});
