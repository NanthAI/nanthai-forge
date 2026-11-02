// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCheckoutMaterialization } from '../dist/checkout-materialization.js';
import {
  stageHostedFiles,
  flushHostedFiles,
  flushHostedCheckoutFiles,
} from '../dist/hosted-checkout-files.js';
import { checkoutVolumeCapacity } from '../dist/checkout-io.js';
import { digest } from '../dist/hash.js';

test('real copy/hash and concurrent file/directory barriers share the runtime and host I/O permits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-checkout-io-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const objects = join(root, 'objects'),
    stage = join(root, 'stage');
  mkdirSync(objects);
  mkdirSync(stage);
  mkdirSync(join(stage, '.forge'));
  const files = Array.from({ length: 40 }, (_, i) => {
    const bytes = Buffer.from(`anonymous ${i}`),
      blob = digest(bytes);
    writeFileSync(join(objects, blob), bytes, { mode: 0o600 });
    return { path: `src/${i}.txt`, blob, mode: 'file' };
  });
  const originals = { copyFile: fs.copyFile, chmod: fs.chmod, open: fs.open };
  const previous = process.env.UV_THREADPOOL_SIZE;
  process.env.UV_THREADPOOL_SIZE = '4';
  t.after(() => {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = previous;
  });
  let active = 0,
    peak = 0,
    opened = 0,
    closed = 0;
  const counted = async run => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise(r => setImmediate(r));
      return await run();
    } finally {
      active--;
    }
  };
  for (const name of ['copyFile', 'chmod']) fs[name] = (...args) => counted(() => originals[name](...args));
  fs.open = async (...args) => {
    const handle = await counted(() => originals.open(...args));
    opened++;
    const sync = handle.sync.bind(handle),
      close = handle.close.bind(handle);
    handle.sync = () => counted(sync);
    handle.close = async () => {
      await counted(close);
      closed++;
    };
    return handle;
  };
  syncBuiltinESMExports();
  await withCheckoutMaterialization(stage, async () => {
    await stageHostedFiles(stage, objects, files);
    const results = await Promise.allSettled([
      flushHostedFiles(stage, files),
      flushHostedCheckoutFiles(stage, files),
    ]);
    for (const result of results) assert.equal(result.status, 'fulfilled');
  });
  assert.equal(peak, Math.min(4, checkoutVolumeCapacity()));
  assert.equal(active, 0);
  assert.equal(opened, closed);
  assert(opened >= 40);
  for (const file of files) {
    assert.equal(digest(readFileSync(join(stage, file.path))), file.blob);
    assert.equal(lstatSync(join(stage, file.path)).nlink, 1);
    assert.notEqual(lstatSync(join(stage, file.path)).ino, lstatSync(join(objects, file.blob)).ino);
  }
});
