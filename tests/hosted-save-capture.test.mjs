// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  renameSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { digest } from '../dist/hash.js';
import { saveFixture, api, jobApi } from './hosted-saves-fixture.mjs';
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-save-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function marker(root, s, materialized = ['a.txt']) {
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: s.laneId,
        intentId: randomUUID(),
        head: s.baseline.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state: s.state,
      scope: ['a.txt'],
      materialized,
    }),
  );
}
test('sparse omissions survive; explicit delete, rename, executable, symlink and binary bytes become exact deltas', async t => {
  const base = directory(t),
    root = join(base, 'checkout');
  mkdirSync(root);
  const s = await saveFixture();
  marker(root, s);
  writeFileSync(join(root, 'a.txt'), 'original');
  renameSync(join(root, 'a.txt'), join(root, 'renamed'));
  writeFileSync(join(root, 'binary'), Buffer.from([0, 255, 128]));
  chmodSync(join(root, 'binary'), 0o755);
  symlinkSync(Buffer.from([0x66, 0x80]), join(root, 'dangling'));
  const capture = await captureHostedSave(root, join(base, 'capture'));
  assert(!capture.changes.some(c => c.path === 'hidden.txt'));
  assert.equal(capture.changes.find(c => c.path === 'a.txt').after, null);
  assert.equal(capture.changes.find(c => c.path === 'renamed').before, null);
  assert.equal(capture.changes.find(c => c.path === 'binary').after.mode, 'executable');
  assert.equal(capture.changes.find(c => c.path === 'dangling').after.mode, 'symlink');
  const dangling = capture.changes.find(c => c.path === 'dangling').after;
  assert.deepEqual(readFileSync(join(base, 'capture', dangling.blob)), Buffer.from([0x66, 0x80]));
  const x = await s.prepare(capture.changes);
  for (const file of capture.files) s.put(readFileSync(join(base, 'capture', file.path)));
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  await s.publish(output);
  const state = JSON.parse(s.objects.get(output.head));
  assert.equal(state.files.find(f => f.path === 'hidden.txt').blob, s.hidden.sha256);
  assert(!state.files.some(f => f.path === 'a.txt'));
});
test('lost upload and final submit replies keep original disk bytes after subsequent local edits', async t => {
  const base = directory(t),
    root = join(base, 'checkout');
  mkdirSync(root);
  const s = await saveFixture();
  marker(root, s);
  writeFileSync(join(root, 'a.txt'), 'first edit');
  let lost = true,
    finalLost = true,
    deltaPuts = 0;
  const retained = new Set();
  const exchange = {
    projectId: s.projectId,
    async missing(pins) {
      return pins.filter(pin => !s.objects.has(pin.sha256)).map(pin => pin.sha256);
    },
    async uploadLazyBatch(objects) {
      for (const { pin, read } of objects) {
        if (!retained.has(pin.sha256)) {
          const bytes = await read();
          assert.equal(digest(bytes), pin.sha256);
          s.put(bytes);
          if (pin.sha256 === digest('first edit')) deltaPuts++;
          retained.add(pin.sha256);
          if (lost) {
            lost = false;
            throw Error('lost PUT reply');
          }
        }
      }
      return { uploadedObjects: 0, uploadedBytes: 0 };
    },
    async upload(pin, bytes) {
      assert.equal(digest(bytes), pin.sha256);
      s.put(bytes);
      return { uploadedObjects: 0, uploadedBytes: 0 };
    },
    client: {
      async mutation(ref, args) {
        const name = getFunctionName(ref);
        if (name === 'projectObjectDownloads:describe')
          return args.digests.map(id => ({ digest: id, size: s.objects.get(id).length, location: 'r2' }));
        if (name === 'projectHostedSaves:prepare') return s.call('prepare', api.prepare, args);
        if (name === 'projectHostedSaves:stage') return s.call('stage', api.stage, args);
        if (name === 'projectHostedSaveJobs:submit') {
          const x = { request: { operationId: args.operationId } },
            result = await s.submit(x);
          if (finalLost) {
            finalLost = false;
            throw Error('lost submit reply');
          }
          return JSON.stringify(result);
        }
        assert.fail(name);
      },
      async query(ref, args) {
        assert.equal(getFunctionName(ref), 'projectHostedSaves:progress');
        return s.call('progress', api.progress, args);
      },
    },
  };
  const request = { operationId: randomUUID(), message: 'retained original' };
  await assert.rejects(saveHostedLane(root, request, exchange), /lost PUT/);
  writeFileSync(join(root, 'a.txt'), 'later local edit');
  await assert.rejects(saveHostedLane(root, request, exchange), /lost submit/);
  const pending = await saveHostedLane(root, request, exchange);
  assert.equal(pending.status, 'submitted');
  assert.equal(deltaPuts, 1);
  const output = await s.work({ request }),
    terminal = await s.publish(output);
  assert.deepEqual(await saveHostedLane(root, request, exchange), terminal);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'later local edit');
  const state = JSON.parse(s.objects.get(output.head));
  assert.equal(state.files.find(f => f.path === 'a.txt').blob, digest('first edit'));
  await assert.rejects(
    saveHostedLane(root, { ...request, message: 'different' }, exchange),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});
test('128 MiB source capture is disk-backed with bounded stream chunks', async t => {
  const base = directory(t),
    root = join(base, 'checkout');
  mkdirSync(root);
  const s = await saveFixture();
  marker(root, s);
  writeFileSync(join(root, 'a.txt'), 'original');
  const file = join(root, 'large.bin'),
    fd = openSync(file, 'wx'),
    chunk = Buffer.alloc(1024 * 1024, 0x41),
    hash = createHash('sha256');
  try {
    for (let i = 0; i < 128; i++) {
      writeSync(fd, chunk);
      hash.update(chunk);
    }
  } finally {
    closeSync(fd);
  }
  const captured = await captureHostedSave(root, join(base, 'capture'));
  assert.equal(captured.changes.length, 1);
  const pin = captured.files[0].pin;
  assert.equal(pin.size, 128 * 1024 * 1024);
  assert.equal(pin.sha256, hash.digest('hex'));
  t.diagnostic(
    JSON.stringify({
      logicalBytes: pin.size,
      retainedFiles: captured.files.length,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});
