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
