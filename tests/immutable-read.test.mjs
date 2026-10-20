// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { digest } from '../dist/hash.js';
import { readSource } from '../dist/files.js';
import { NativeSource } from '../dist/native-source.js';
import { touchCtime } from './helpers.mjs';

test('native hash-bound timestamps and mutable stable ctime-only hydration retain content/authority failures', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'forge-immutable-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('exact retained source\n'),
    source = new NativeSource(root),
    id = source.put(bytes);
  const path = join(source.directory, id),
    read = fs.readSync;
  t.after(() => {
    fs.readSync = read;
    syncBuiltinESMExports();
  });
  function duringRead(kind) {
    fs.readSync = read;
    syncBuiltinESMExports();
    for (const name of ['linked', 'moved']) fs.rmSync(join(root, name), { force: true });
    fs.rmSync(path, { force: true });
    fs.writeFileSync(path, bytes, { mode: 0o600 });
    let reads = 0;
    fs.readSync = function (...args) {
      const count = read.apply(this, args);
      reads++;
      if (reads === 1 || (kind === 'unstable' && reads === 3)) {
        const stat = fs.statSync(path);
        if (kind === 'content') {
          fs.writeFileSync(path, Buffer.from('other retained bytes!\n'));
          fs.utimesSync(path, stat.atime, stat.mtime);
        } else if (kind === 'size') fs.appendFileSync(path, 'x');
        else if (kind === 'timestamps') fs.utimesSync(path, stat.atime, new Date(stat.mtimeMs + 1000));
        else if (kind === 'permissions') fs.chmodSync(path, 0o400);
        else if (kind === 'link') fs.linkSync(path, join(root, 'linked'));
        else if (kind === 'replacement' || kind === 'symlink') {
          fs.renameSync(path, join(root, 'moved'));
          if (kind === 'symlink') fs.symlinkSync(join(root, 'moved'), path);
          else fs.writeFileSync(path, bytes, { mode: 0o600 });
        } else touchCtime(path);
      }
      return count;
    };
    syncBuiltinESMExports();
    return () => reads;
  }
  duringRead('once');
  assert.deepEqual(source.object(id), bytes);
  let reads = duringRead('once');
  assert.deepEqual(readSource(source.directory, id, 1024), bytes);
  assert.ok(reads() >= 3, 'Mutable hydration needs an identical stable reread.');
  duringRead('timestamps');
  assert.deepEqual(source.object(id), bytes);
  duringRead('timestamps');
  assert.throws(
    () => readSource(source.directory, id, 1024),
    e => e.code === 'SOURCE_CHANGED',
  );
  duringRead('once');
  assert.throws(
    () => readSource(source.directory, id, 1024, digest('different bytes')),
    e => e.code === 'SOURCE_CHANGED',
  );
  for (const kind of ['content', 'size', 'permissions', 'link', 'replacement', 'symlink', 'unstable']) {
    duringRead(kind);
    assert.throws(
      () => source.object(id),
      e => e.code === 'SOURCE_CHANGED',
      kind,
    );
    duringRead(kind);
    assert.throws(
      () => readSource(source.directory, id, 1024),
      e => e.code === 'SOURCE_CHANGED',
      kind,
    );
  }
  fs.readSync = read;
  syncBuiltinESMExports();
  for (const name of ['linked', 'moved']) fs.rmSync(join(root, name), { force: true });
  fs.rmSync(path, { force: true });
  fs.writeFileSync(path, 'tampered source', { mode: 0o600 });
  assert.throws(
    () => source.object(id),
    e => e.code === 'INVALID_NATIVE_SOURCE',
  );
});
