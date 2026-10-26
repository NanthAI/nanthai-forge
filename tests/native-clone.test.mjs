// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneNativePath } from '../dist/native-clone.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-clone-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  writeFileSync(source, 'source bytes');
  return { root, source, target };
}

test('clone never replaces an existing destination', t => {
  const f = fixture(t);
  writeFileSync(f.target, 'existing work');
  assert.throws(() => cloneNativePath(f.source, f.target), { code: 'EEXIST' });
  assert.equal(readFileSync(f.target, 'utf8'), 'existing work');
});

test('disk errors preserve their original code instead of becoming copy fallbacks', t => {
  const f = fixture(t),
    originalExec = childProcess.execFileSync,
    originalCopy = fs.copyFileSync;
  childProcess.execFileSync = (file, args, options) => {
    if (file === '/bin/cp') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return originalExec(file, args, options);
  };
  fs.copyFileSync = () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = originalExec;
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
  });
  assert.throws(() => cloneNativePath(f.source, f.target), { code: 'ENOSPC' });
});

test(
  'a non-APFS filesystem is recorded before cp can silently use ordinary copying',
  { skip: process.platform !== 'darwin' },
  t => {
    const f = fixture(t),
      originalExec = childProcess.execFileSync,
      originalStatfs = fs.statfsSync;
    let cloneCalls = 0;
    // A new synthetic filesystem type avoids the process-local APFS capability
    // memo, without changing the source/destination device or real file bytes.
    fs.statfsSync = (...args) => ({ ...originalStatfs(...args), type: 9_999_999 });
    childProcess.execFileSync = (file, args, options) => {
      if (file === '/usr/sbin/diskutil')
        return '<plist><dict><key>FilesystemType</key><string>hfs</string></dict></plist>';
      if (file === '/bin/cp') cloneCalls++;
      return originalExec(file, args, options);
    };
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.execFileSync = originalExec;
      fs.statfsSync = originalStatfs;
      syncBuiltinESMExports();
    });
    assert.deepEqual(cloneNativePath(f.source, f.target), { method: 'copy', reason: 'not-apfs' });
    assert.equal(cloneCalls, 0);
    assert.equal(readFileSync(f.target, 'utf8'), 'source bytes');
  },
);
