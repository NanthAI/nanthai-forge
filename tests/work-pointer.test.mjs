// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkPointer } from '../dist/work-pointer.js';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-pointer-read-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'work.json');
  fs.writeFileSync(path, '{"revision":1}');
  return { directory, path };
}
function duringRead(t, change) {
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    if (!changed && count) {
      changed = true;
      change();
    }
    return count;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('an atomic replacement returns the coherent opened pointer without retrying the new pathname', t => {
  const f = fixture(t);
  duringRead(t, () => {
    fs.writeFileSync(join(f.directory, 'next'), '{"revision":2}');
    fs.renameSync(join(f.directory, 'next'), f.path);
  });
  assert.equal(readWorkPointer(f.directory).toString(), '{"revision":1}');
  assert.equal(fs.readFileSync(f.path, 'utf8'), '{"revision":2}');
});

test('in-place mutation during a pointer read still fails explicitly', t => {
  const f = fixture(t);
  duringRead(t, () => fs.writeFileSync(f.path, '{"revision":200}'));
  assert.throws(() => readWorkPointer(f.directory), { code: 'SOURCE_CHANGED' });
});

test('pointer reads refuse symbolic links, hard links and directories and preserve missing owners', t => {
  const f = fixture(t);
  fs.renameSync(f.path, join(f.directory, 'target'));
  fs.symlinkSync(join(f.directory, 'target'), f.path);
  assert.equal(readWorkPointer(f.directory), null);
  fs.unlinkSync(f.path);
  fs.linkSync(join(f.directory, 'target'), f.path);
  assert.equal(readWorkPointer(f.directory), null);
  fs.unlinkSync(f.path);
  fs.mkdirSync(f.path);
  assert.equal(readWorkPointer(f.directory), null);
  fs.rmSync(f.directory, { recursive: true });
  assert.equal(readWorkPointer(f.directory), null);
  assert.equal(fs.existsSync(f.directory), false);
});

test('pointer IO failures retain a structured read error', t => {
  const f = fixture(t);
  t.mock.method(fs, 'lstatSync', () => {
    throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(() => readWorkPointer(f.directory), { code: 'SOURCE_READ_FAILED' });
});

test('rename followed by unlink may change ctime again during descriptor validation', t => {
  const f = fixture(t),
    stat = fs.fstatSync;
  let calls = 0,
    initial;
  t.mock.method(fs, 'fstatSync', (...args) => {
    const value = stat(...args);
    calls++;
    if (calls === 1) {
      initial = value;
      return value;
    }
    // Linux can expose rename's ctime first, then unlink's ctime and link count
    // while this reader still holds that inode. Both snapshots have exact bytes.
    return { ...value, nlink: calls === 2 ? 1 : 0, ctimeMs: initial.ctimeMs + calls };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  duringRead(t, () => {
    fs.writeFileSync(join(f.directory, 'next'), '{"revision":2}');
    fs.renameSync(join(f.directory, 'next'), f.path);
  });
  assert.equal(readWorkPointer(f.directory).toString(), '{"revision":1}');
  assert.equal(calls, 3);
});
