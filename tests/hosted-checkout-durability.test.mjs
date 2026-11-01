// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/hash.js';
import { installHostedFiles, flushHostedCheckoutFiles } from '../dist/hosted-checkout-files.js';

function fixture(t, count = 3) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-checkout-durable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const objects = join(directory, 'objects'),
    stage = join(directory, 'stage');
  mkdirSync(objects);
  mkdirSync(stage);
  const files = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from([0, 255, index]),
      blob = digest(bytes);
    writeFileSync(join(objects, blob), bytes, { mode: 0o600 });
    return { path: `src/${index}.bin`, blob, mode: index === 0 ? 'executable' : 'file' };
  });
  const target = Buffer.from('src/0.bin'),
    blob = digest(target);
  writeFileSync(join(objects, blob), target, { mode: 0o600 });
  files.push({ path: 'link', blob, mode: 'symlink' });
  const original = fs.open;
  t.after(() => {
    fs.open = original;
    syncBuiltinESMExports();
  });
  return { objects, stage, files, original };
}

test('all staged bytes and modes are ready before durability; every regular file is fsynced', async t => {
  const s = fixture(t),
    flushed = [];
  fs.open = async (...args) => {
    const handle = await s.original(...args),
      sync = handle.sync.bind(handle);
    handle.sync = async () => {
      for (const file of s.files) {
        const path = join(s.stage, file.path);
        const bytes = file.mode === 'symlink' ? Buffer.from(readlinkSync(path)) : readFileSync(path);
        assert.equal(digest(bytes), file.blob);
        if (file.mode !== 'symlink')
          assert.equal(lstatSync(path).mode & 0o777, file.mode === 'executable' ? 0o755 : 0o644);
      }
      flushed.push(args[0]);
      await sync();
    };
    return handle;
  };
  syncBuiltinESMExports();
  await installHostedFiles(s.stage, s.objects, s.files);
  assert.deepEqual(
    flushed.sort(),
    s.files
      .filter(file => file.mode !== 'symlink')
      .map(file => join(s.stage, file.path))
      .sort(),
  );
});

test('a failed durability pass propagates its error after closing every in-flight descriptor', async t => {
  const s = fixture(t, 20),
    failure = new Error('synthetic fsync failure');
  let opened = 0,
    closed = 0,
    failed = false;
  fs.open = async (...args) => {
    const handle = await s.original(...args),
      sync = handle.sync.bind(handle),
      close = handle.close.bind(handle);
    opened++;
    handle.sync = async () => {
      if (!failed) {
        failed = true;
        throw failure;
      }
      await sync();
    };
    handle.close = async () => {
      await close();
      closed++;
    };
    return handle;
  };
  syncBuiltinESMExports();
  await assert.rejects(installHostedFiles(s.stage, s.objects, s.files), error => error === failure);
  assert(opened > 0);
  assert.equal(closed, opened, 'cleanup cannot race an unfinished write or leave file descriptors open');
});

test(
  'the private-stage manifest flushes every ancestor and metadata directory without following links',
  {
    skip: process.platform === 'win32',
  },
  async t => {
    const s = fixture(t);
    s.files[0].path = 'deep/a/b/run';
    await installHostedFiles(s.stage, s.objects, s.files);
    mkdirSync(join(s.stage, '.forge'));
    const flushed = [];
    fs.open = async (...args) => {
      const handle = await s.original(...args),
        sync = handle.sync.bind(handle);
      handle.sync = async () => {
        assert(lstatSync(args[0]).isDirectory());
        flushed.push(args[0]);
        await sync();
      };
      return handle;
    };
    syncBuiltinESMExports();
    await flushHostedCheckoutFiles(s.stage, s.files);
    assert.deepEqual(
      flushed.sort(),
      ['', '.forge', 'deep', 'deep/a', 'deep/a/b', 'src'].map(path => join(s.stage, path)).sort(),
    );
  },
);
