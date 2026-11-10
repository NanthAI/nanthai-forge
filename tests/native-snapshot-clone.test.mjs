// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { snapshotBlob } from '../dist/native-snapshot-clone.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-snapshot-clone-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = new NativeSource(root);
  source.put(Buffer.from('seed object directory'));
  return { root, source, path: join(root, 'live.bin'), bytes: Buffer.alloc(8 * 1024 * 1024, 37) };
}
function replaceClone(t, replacement) {
  const originalExec = childProcess.execFileSync,
    originalCopy = fs.copyFileSync;
  childProcess.execFileSync = (file, args, options) =>
    file === '/bin/cp'
      ? replacement(() => originalExec(file, args, options), args.at(-1))
      : originalExec(file, args, options);
  fs.copyFileSync = (source, destination, flags) =>
    flags & fs.constants.COPYFILE_FICLONE_FORCE
      ? replacement(() => originalCopy(source, destination, flags), destination)
      : originalCopy(source, destination, flags);
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = originalExec;
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
  });
}

test('snapshot blob clones preserve captured bytes after later edits to the live file', t => {
  const f = fixture(t);
  writeFileSync(f.path, f.bytes);
  const retained = snapshotBlob(f.source, f.path, f.bytes, false);
  writeFileSync(f.path, 'later edit');
  assert.deepEqual(f.source.object(retained.blob), f.bytes);
  assert.equal(fs.lstatSync(join(f.source.directory, retained.blob)).nlink, 1);
  assert.equal(fs.lstatSync(join(f.source.directory, retained.blob)).mode & 0o777, 0o600);
  assert.ok(['clone', 'copy'].includes(retained.storage.method));
  assert.equal(
    readdirSync(f.source.directory).some(name => name.endsWith('.tmp')),
    false,
  );
});

test('a changed clone retains the original capture and records its reason', t => {
  const f = fixture(t);
  writeFileSync(f.path, f.bytes);
  // Simulate a clone that succeeded but captured a concurrent edit; real clones are
  // unavailable on some filesystems (Linux CI returns ENOTSUP).
  replaceClone(t, (_clone, target) => {
    writeFileSync(target, 'concurrent edit');
  });
  const retained = snapshotBlob(f.source, f.path, f.bytes, false);
  assert.deepEqual(f.source.object(retained.blob), f.bytes);
  assert.deepEqual(retained.storage, { method: 'copy', reason: 'source-changed-during-clone' });
  assert.equal(
    readdirSync(f.source.directory).some(name => name.endsWith('.tmp')),
    false,
  );
});

test('unsupported snapshot clones use copy fallback with an explicit reason', t => {
  const f = fixture(t);
  writeFileSync(f.path, f.bytes);
  replaceClone(t, () => {
    throw Object.assign(new Error('Unsupported filesystem'), { code: 'ENOTSUP' });
  });
  const retained = snapshotBlob(f.source, f.path, f.bytes, false);
  assert.deepEqual(f.source.object(retained.blob), f.bytes);
  assert.deepEqual(retained.storage, { method: 'copy', reason: 'ENOTSUP' });
});

test(
  'snapshot clones do not carry source xattrs or file flags into retained objects',
  { skip: process.platform !== 'darwin' },
  t => {
    const f = fixture(t);
    writeFileSync(f.path, f.bytes);
    childProcess.execFileSync('/usr/bin/xattr', ['-w', 'com.nanthai.fixture', 'source-only', f.path]);
    childProcess.execFileSync('/usr/bin/xattr', [
      '-w',
      'com.apple.quarantine',
      '0081;fixture;fixture;',
      f.path,
    ]);
    childProcess.execFileSync('/usr/bin/chflags', ['hidden', f.path]);
    const retained = snapshotBlob(f.source, f.path, f.bytes, false),
      target = join(f.source.directory, retained.blob);
    const attributes = childProcess.execFileSync('/usr/bin/xattr', [target], { encoding: 'utf8' });
    // macOS may attach its own provenance attribute even to fresh byte writes.
    assert.equal(attributes.includes('com.nanthai.fixture'), false);
    assert.equal(attributes.includes('com.apple.quarantine'), false);
    assert.equal(
      childProcess.execFileSync('/usr/bin/stat', ['-f', '%f', target], { encoding: 'utf8' }).trim(),
      '0',
    );
    assert.equal(
      childProcess
        .execFileSync('/usr/bin/xattr', ['-p', 'com.nanthai.fixture', f.path], { encoding: 'utf8' })
        .trim(),
      'source-only',
    );
    assert.deepEqual(f.source.object(retained.blob), f.bytes);
  },
);
