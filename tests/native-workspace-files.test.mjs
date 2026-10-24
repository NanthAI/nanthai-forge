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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeSource } from '../dist/native-source.js';
import { NativeMaterialization } from '../dist/native-materialization.js';
import { digest } from '../dist/hash.js';

function fixture(t, size = 32 * 1024 * 1024) {
  const owner = realpathSync(mkdtempSync(join(tmpdir(), 'forge-clone-materialization-')));
  t.after(() => rmSync(owner, { recursive: true, force: true }));
  const source = new NativeSource(owner),
    bytes = Buffer.alloc(size, 23),
    blob = source.put(bytes);
  const head = source.writeState(
    [
      { path: 'nested/a.bin', blob, mode: 'file' },
      { path: 'run.bin', blob, mode: 'executable' },
    ],
    [],
    'Independent file copies',
    '2026-01-01T00:00:00.000Z',
  );
  return { owner, source, bytes, blob, head };
}
function assertWorkspace(f, root) {
  for (const [path, mode] of [
    ['nested/a.bin', 0o600],
    ['run.bin', 0o700],
  ]) {
    const absolute = join(root, path),
      stat = lstatSync(absolute);
    assert.equal(digest(readFileSync(absolute)), f.blob);
    assert.equal(stat.mode & 0o777, mode);
    assert.equal(stat.nlink, 1);
  }
}
function assertNoTemplates(f) {
  assert.equal(
    readdirSync(join(f.owner, '.forge/work')).some(name => name.startsWith('.materialization-')),
    false,
  );
}
function replaceCopy(t, replacement) {
  const originalCopy = fs.copyFileSync,
    originalExec = childProcess.execFileSync;
  // A successful copy can be simulated even on CI filesystems without reflinks;
  // the unpatched independence test above exercises the platform's real path.
  fs.copyFileSync = (source, target) =>
    replacement(() => originalCopy(source, target, fs.constants.COPYFILE_EXCL), source, target);
  childProcess.execFileSync = (file, args, options) =>
    file === '/bin/cp'
      ? replacement(() => originalExec(file, args, options), args.at(-2), args.at(-1))
      : originalExec(file, args, options);
  syncBuiltinESMExports();
  t.after(() => {
    fs.copyFileSync = originalCopy;
    childProcess.execFileSync = originalExec;
    syncBuiltinESMExports();
  });
}

test('large eager workspaces retain bytes, modes and independent inodes across ordinary and shared recovery materialization', t => {
  const f = fixture(t),
    ordinary = join(f.owner, 'ordinary');
  f.source.materialize(f.head, ordinary, false);
  assertWorkspace(f, ordinary);
  assertNoTemplates(f);
  const reader = new NativeMaterialization(f.owner),
    a = join(f.owner, 'first'),
    b = join(f.owner, 'second');
  try {
    reader.materialize(f.head, a, false);
    writeFileSync(join(a, 'nested/a.bin'), 'independent edit');
    reader.materialize(f.head, b, false);
    assertWorkspace(f, b);
    assert.equal(digest(readFileSync(join(f.source.directory, f.blob))), f.blob);
    assert.equal(digest(readFileSync(join(a, 'run.bin'))), f.blob);
    assert.notEqual(lstatSync(join(b, 'run.bin')).ino, lstatSync(join(a, 'run.bin')).ino);
    assert.throws(
      () => reader.materialize(f.head, a, false),
      error => error.code === 'RESTORE_TARGET_EXISTS',
    );
  } finally {
    reader.dispose();
  }
  assertNoTemplates(f);
});

test('unsupported cloning falls back to original eager writable files and cleans temporary state', t => {
  const f = fixture(t);
  let attempts = 0;
  replaceCopy(t, () => {
    attempts++;
    throw Object.assign(new Error('Unavailable clone support'), {
      code: process.platform === 'darwin' ? 'ENOENT' : 'ENOSYS',
    });
  });
  const target = join(f.owner, 'fallback'),
    reader = new NativeMaterialization(f.owner);
  try {
    reader.materialize(f.head, target, false);
  } finally {
    reader.dispose();
  }
  assertWorkspace(f, target);
  assert.equal(attempts, 1);
  assertNoTemplates(f);
});

test('changed clone bytes fail before a workspace appears and remove all private templates', t => {
  const f = fixture(t),
    target = join(f.owner, 'changed');
  replaceCopy(t, (copy, _source, destination) => {
    const result = copy();
    writeFileSync(destination, Buffer.alloc(f.bytes.length, 24));
    return result;
  });
  const reader = new NativeMaterialization(f.owner);
  try {
    assert.throws(
      () => reader.materialize(f.head, target, false),
      error => error.code === 'INVALID_NATIVE_SOURCE',
    );
  } finally {
    reader.dispose();
  }
  assert.equal(existsSync(target), false);
  assertNoTemplates(f);
  assert.equal(digest(readFileSync(join(f.source.directory, f.blob))), f.blob);
});

test('copy failure preserves original source and cleans private templates without publishing a workspace', t => {
  const f = fixture(t),
    target = join(f.owner, 'failed');
  const original = fs.mkdtempSync;
  fs.mkdtempSync = prefix => {
    if (prefix.includes('.materialization-'))
      throw Object.assign(new Error('Simulated disk failure'), { code: 'ENOSPC' });
    return original(prefix);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.mkdtempSync = original;
    syncBuiltinESMExports();
  });
  const reader = new NativeMaterialization(f.owner);
  try {
    assert.throws(
      () => reader.materialize(f.head, target, false),
      error => error.code === 'ENOSPC',
    );
  } finally {
    reader.dispose();
  }
  assert.equal(existsSync(target), false);
  assertNoTemplates(f);
  assert.equal(digest(readFileSync(join(f.source.directory, f.blob))), f.blob);
});

test('unsupported clone command flags do not prevent ordinary or recovery materialization', t => {
  const f = fixture(t);
  replaceCopy(t, () => {
    throw process.platform === 'darwin'
      ? Object.assign(new Error('cp: unsupported option'), { status: 1 })
      : Object.assign(new Error('Unsupported reflink'), { code: 'ENOSYS' });
  });
  const ordinary = join(f.owner, 'ordinary-fallback');
  f.source.materialize(f.head, ordinary, false);
  assertWorkspace(f, ordinary);
  const reader = new NativeMaterialization(f.owner),
    recovered = join(f.owner, 'recovery-fallback');
  try {
    reader.materialize(f.head, recovered, false);
    assertWorkspace(f, recovered);
  } finally {
    reader.dispose();
  }
  assertNoTemplates(f);
});

test('a concurrently created destination is preserved and its exclusive-copy error is not swallowed', t => {
  const f = fixture(t),
    target = join(f.owner, 'racing'),
    path = join(target, 'nested/a.bin');
  replaceCopy(t, (copy, source) => {
    if (source.includes('.materialization-') && existsSync(join(target, 'nested')) && !existsSync(path))
      writeFileSync(path, 'concurrent work', { flag: 'wx' });
    return copy();
  });
  const reader = new NativeMaterialization(f.owner);
  try {
    assert.throws(
      () => reader.materialize(f.head, target, false),
      error => error.code === 'EEXIST',
    );
  } finally {
    reader.dispose();
  }
  assert.equal(readFileSync(path, 'utf8'), 'concurrent work');
  assertNoTemplates(f);
});

test('fresh materialization revalidates large object bytes instead of reusing prior proof', t => {
  const f = fixture(t);
  f.source.materialize(f.head, join(f.owner, 'original'), false);
  writeFileSync(join(f.source.directory, f.blob), Buffer.alloc(f.bytes.length, 24));
  const target = join(f.owner, 'corrupt');
  assert.throws(
    () => new NativeMaterialization(f.owner).materialize(f.head, target, false),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
  assert.equal(existsSync(target), false);
  assertNoTemplates(f);
});

test('an unavailable workspace clone uses ordinary copying after successful template preparation', t => {
  const f = fixture(t),
    target = join(f.owner, 'copy-fallback'),
    original = childProcess.execFileSync;
  let copies = 0;
  childProcess.execFileSync = (file, args, options) => {
    if (file === '/bin/cp' && copies++ > 0)
      throw Object.assign(new Error('Clone unavailable for destination'), { status: 1 });
    return original(file, args, options);
  };
  syncBuiltinESMExports();
  const reader = new NativeMaterialization(f.owner);
  try {
    reader.materialize(f.head, target, false);
  } finally {
    reader.dispose();
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
  assertWorkspace(f, target);
  assertNoTemplates(f);
});

test('large workspace copies keep the bytes-only contract without source quarantine or hidden flags', t => {
  const f = fixture(t),
    object = join(f.source.directory, f.blob),
    target = join(f.owner, 'metadata');
  if (process.platform === 'darwin') {
    childProcess.execFileSync('/usr/bin/xattr', [
      '-w',
      'com.apple.quarantine',
      '0081;fixture;fixture;',
      object,
    ]);
    childProcess.execFileSync('/usr/bin/xattr', ['-w', 'com.nanthai.fixture', 'source-only', object]);
    childProcess.execFileSync('/usr/bin/chflags', ['hidden', object]);
  }
  f.source.materialize(f.head, target, false);
  assertWorkspace(f, target);
  assertNoTemplates(f);
  const recovered = join(f.owner, 'recovered-metadata'),
    reader = new NativeMaterialization(f.owner);
  try {
    reader.materialize(f.head, recovered, false);
    assertWorkspace(f, recovered);
  } finally {
    reader.dispose();
  }
  if (process.platform === 'darwin') {
    for (const root of [target, recovered]) {
      const file = join(root, 'nested/a.bin'),
        attrs = childProcess.execFileSync('/usr/bin/xattr', [file], { encoding: 'utf8' });
      assert.equal(attrs.includes('com.apple.quarantine'), false);
      assert.equal(attrs.includes('com.nanthai.fixture'), false);
      assert.equal(
        childProcess.execFileSync('/usr/bin/stat', ['-f', '%f', file], { encoding: 'utf8' }).trim(),
        '0',
      );
    }
    assert.equal(
      childProcess
        .execFileSync('/usr/bin/xattr', ['-p', 'com.nanthai.fixture', object], { encoding: 'utf8' })
        .trim(),
      'source-only',
    );
    assert.equal(
      childProcess.execFileSync('/usr/bin/stat', ['-f', '%Sf', object], { encoding: 'utf8' }).trim(),
      'hidden',
    );
  }
});

test('readable immutable source needs no metadata normalizers and leaves no templates', t => {
  const f = fixture(t),
    target = join(f.owner, 'normalization-fallback'),
    original = childProcess.execFileSync;
  const object = join(f.source.directory, f.blob);
  if (process.platform === 'darwin') original('/usr/bin/chflags', ['uchg', object]);
  childProcess.execFileSync = (file, args, options) => {
    if (file === '/usr/bin/xattr' || file === '/usr/bin/chflags')
      throw Object.assign(new Error('Unavailable metadata utility'), { code: 'ENOENT' });
    return original(file, args, options);
  };
  syncBuiltinESMExports();
  const reader = new NativeMaterialization(f.owner);
  try {
    reader.materialize(f.head, target, false);
    assertWorkspace(f, target);
    writeFileSync(join(target, 'nested/a.bin'), 'writable');
    if (process.platform === 'darwin')
      assert.equal(original('/usr/bin/stat', ['-f', '%Sf', object], { encoding: 'utf8' }).trim(), 'uchg');
  } finally {
    reader.dispose();
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    if (process.platform === 'darwin') original('/usr/bin/chflags', ['0', object]);
  }
  assertNoTemplates(f);
});
