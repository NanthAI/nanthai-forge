// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { exportNativeGit } from '../dist/native-git.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { workGit } from '../dist/work-git.js';
import { processAlive } from '../dist/local-process.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-export-waits-')),
    root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.txt'), 'immutable source\n');
  const { head } = initNative(root),
    target = join(directory, 'export');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { directory, root, head, target };
}
function fakeGit(directory, script) {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return bin + ':' + process.env.PATH;
}
function runExport(f, env = {}) {
  const child = spawn(process.execPath, ['dist/cli.js', 'export-native-git', f.root, f.head, f.target], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', bytes => {
    stdout += bytes;
  });
  child.stderr.on('data', bytes => {
    stderr += bytes;
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail('Fixture did not reach the expected state');
}

test('exact immutable export completes while another process holds the owner lock', async t => {
  const f = fixture(t),
    store = new WorkStore(f.root),
    before = readFileSync(join(store.directory, 'work.json'));
  const ready = join(f.directory, 'ready'),
    release = join(f.directory, 'release');
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { WorkStore } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/work-store.js')).href)};
    import { existsSync, writeFileSync } from 'node:fs';
    new WorkStore(${JSON.stringify(f.root)}).locked(() => {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    });
  `,
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise(resolve => holder.on('close', resolve));
  t.after(async () => {
    holder.kill('SIGKILL');
    await exited;
  });
  await until(() => existsSync(ready));
  writeFileSync(join(f.root, 'source.txt'), 'uncheckpointed edits\n');
  const exported = await exportNativeGit(f.root, f.head, f.target);
  assert.ok(existsSync(join(store.directory, 'lock')), 'export did not wait for or remove the lock');
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), before);
  assert.equal(
    workGit(join(f.target, 'repository.git'), ['show', `${exported.commit}:source.txt`]),
    'immutable source\n',
  );
  assert.equal(new NativeSource(f.root).state(f.head).files.length, 1);
  writeFileSync(release, 'release');
  assert.equal(await exited, 0);
});

test('failed Git includes redacted stderr and status in sync and export errors', async t => {
  const f = fixture(t);
  const message =
    'fatal: synthetic pack failure https://user:fixture-password@example.invalid/repo?token=fixture-query token=fixture-token Bearer fixture-bearer ghp_fixturecredential sk_fixturecredential';
  const path = fakeGit(f.directory, `process.stderr.write(${JSON.stringify(message)}); process.exit(73);`);
  const check = text => {
    assert.match(text, /WORK_GIT_FAILED/);
    assert.match(text, /synthetic pack failure/);
    assert.match(text, /status=73/);
    for (const secret of [
      'fixture-password',
      'fixture-query',
      'fixture-token',
      'fixture-bearer',
      'ghp_fixturecredential',
      'sk_fixturecredential',
    ])
      assert.ok(!text.includes(secret));
  };
  const previous = process.env.PATH;
  try {
    process.env.PATH = path;
    assert.throws(
      () => workGit(f.root, ['status']),
      error => {
        check(`${error.code} ${error.message}`);
        return true;
      },
    );
  } finally {
    process.env.PATH = previous;
  }
  const result = await runExport(f, { PATH: path }).done;
  assert.equal(result.code, 1);
  check(result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(f.target), false);
});

test(
  'slow Git reports its phase and PID then times out, including its pipe-holding helper',
  { timeout: 30000 },
  async t => {
    const f = fixture(t),
      pids = join(f.directory, 'pids');
    const path = fakeGit(
      f.directory,
      `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, helper.pid]));
    process.stderr.write('synthetic Git blocked\\n');
    setInterval(() => {}, 1000);
  `,
    );
    const started = performance.now(),
      execution = runExport(f, { PATH: path, FORGE_GIT_TIMEOUT_MS: '11000' });
    t.after(() => execution.child.kill('SIGKILL'));
    const result = await execution.done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /export-native-git: waiting for Git init; holder=git pid=\d+;/);
    assert.match(result.stderr, /WORK_GIT_TIMEOUT/);
    assert.match(result.stderr, /synthetic Git blocked/);
    assert.match(result.stderr, /signal=SIGKILL/);
    assert.ok(performance.now() - started < 25000, 'the subprocess wait is bounded');
    assert.equal(existsSync(f.target), false);
    const processes = JSON.parse(readFileSync(pids, 'utf8'));
    await until(() => processes.every(pid => !processAlive({ pid })));
  },
);

test('a missing Git executable fails diagnostically without publishing output', async t => {
  const f = fixture(t),
    path = join(f.directory, 'empty-bin');
  mkdirSync(path);
  const result = await runExport(f, { PATH: path }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /WORK_GIT_FAILED/);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(existsSync(f.target), false);
});
