// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource, nativeMarker, nativeOwner } from '../dist/native-source.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-lane-tree-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  nativeMarker(root);
  const source = new NativeSource(root),
    blob = source.put(Buffer.from('original bytes\n'));
  const files = [
    { path: 'nested/a.txt', blob, mode: 'file' },
    { path: 'run', blob, mode: 'executable' },
    { path: 'link', blob: source.put(Buffer.from('nested/a.txt')), mode: 'symlink' },
  ];
  const head = source.writeState(files, [], 'Synthetic source', '2026-01-01T00:00:00.000Z');
  const materialize = () => {
    const path = join(root, '.forge/work', `lane-${randomUUID()}`);
    source.materialize(head, path);
    return path;
  };
  return { root, source, head, materialize, cache: join(root, '.forge/work/lane-source-cache/tree') };
}
const receipt = path => JSON.parse(readFileSync(join(path, '.forge/materialization.json'), 'utf8'));

test('cached Lane clones are exact independent writable trees with one bounded cache', t => {
  const f = fixture(t),
    a = f.materialize();
  writeFileSync(join(a, 'nested/a.txt'), 'Lane edit');
  const b = f.materialize();
  assert.equal(readFileSync(join(b, 'nested/a.txt'), 'utf8'), 'original bytes\n');
  assert.equal(readFileSync(join(f.cache, 'nested/a.txt'), 'utf8'), 'original bytes\n');
  assert.equal(lstatSync(join(b, 'run')).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(b, 'link')).isSymbolicLink(), true);
  assert.equal(lstatSync(join(b, 'run')).nlink, 1);
  assert.notEqual(lstatSync(join(a, 'run')).ino, lstatSync(join(b, 'run')).ino);
  assert.equal(receipt(b).head, f.head);
  assert.equal(nativeOwner(b), f.root);
  assert.ok(['clone', 'copy'].includes(receipt(b).method));
  assert.deepEqual(readdirSync(join(f.cache, '..')).sort(), ['lock-queue', 'tree', 'tree.json']);
  assert.throws(() => f.source.materialize(f.head, b), { code: 'RESTORE_TARGET_EXISTS' });
  assert.equal(readFileSync(join(a, 'nested/a.txt'), 'utf8'), 'Lane edit');
});

for (const change of ['edit', 'extra', 'missing', 'redirect']) {
  test(`a cache ${change} cannot enter a new Lane`, t => {
    const f = fixture(t);
    f.materialize();
    if (change === 'edit') writeFileSync(join(f.cache, 'nested/a.txt'), 'tampered bytes');
    if (change === 'extra') writeFileSync(join(f.cache, '.unexpected'), 'not in State');
    if (change === 'missing') rmSync(join(f.cache, 'nested/a.txt'));
    if (change === 'redirect') {
      rmSync(join(f.cache, 'nested'), { recursive: true });
      fs.symlinkSync(f.root, join(f.cache, 'nested'));
    }
    const path = f.materialize();
    assert.deepEqual(f.source.capture(path, false, f.head), f.source.state(f.head).files);
    assert.equal(existsSync(join(path, '.unexpected')), false);
  });
}

test('unavailable filesystem clones retain exact bytes and record the copy reason', t => {
  const f = fixture(t),
    originalExec = childProcess.execFileSync,
    originalCp = fs.cpSync;
  childProcess.execFileSync = (file, args, options) => {
    if (file === '/bin/cp') throw Object.assign(new Error('No APFS clone support'), { code: 'ENOTSUP' });
    return originalExec(file, args, options);
  };
  fs.cpSync = (source, destination, options) => {
    if (options?.mode === fs.constants.COPYFILE_FICLONE_FORCE)
      throw Object.assign(new Error('No reflink support'), { code: 'ENOTSUP' });
    return originalCp(source, destination, options);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = originalExec;
    fs.cpSync = originalCp;
    syncBuiltinESMExports();
  });
  const path = f.materialize();
  assert.deepEqual(f.source.capture(path, false, f.head), f.source.state(f.head).files);
  assert.deepEqual(receipt(path), { schema: 1, head: f.head, method: 'copy', reason: 'ENOTSUP' });
});

test('source cache follows the exact selected State and does not accumulate old trees', t => {
  const f = fixture(t),
    old = f.materialize(),
    nextBlob = f.source.put(Buffer.from('new main'));
  const next = f.source.writeState(
    f.source
      .state(f.head)
      .files.map(file => (file.path === 'nested/a.txt' ? { ...file, blob: nextBlob } : file)),
    [f.head],
    'New main',
    '2026-01-02T00:00:00.000Z',
  );
  const path = join(f.root, '.forge/work', `lane-${randomUUID()}`);
  f.source.materialize(next, path);
  assert.equal(readFileSync(join(path, 'nested/a.txt'), 'utf8'), 'new main');
  assert.equal(readFileSync(join(old, 'nested/a.txt'), 'utf8'), 'original bytes\n');
  assert.deepEqual(readdirSync(join(f.cache, '..')).sort(), ['lock-queue', 'tree', 'tree.json']);
});
