// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/portable-hash.js';
import { runSmallSourceSave, smallSaveStateBytes } from '../dist/hosted-source-small-save.js';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
const at = '2026-10-28T00:00:00.000Z';

function fixture(count = 4000, changes) {
  const objects = new Map(),
    reads = [],
    writes = [],
    windows = [];
  const put = bytes => {
    bytes = new Uint8Array(bytes);
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const original = put(new TextEncoder().encode('original\n'));
  const files = Array.from({ length: count }, (_, i) => ({
    path: `src/${String(i).padStart(6, '0')}.txt`,
    blob: original.sha256,
    mode: 'file',
  }));
  const baseline = json({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files,
    message: 'baseline',
    at,
  });
  const blob = put(new TextEncoder().encode('changed\n'));
  const delta = changes?.({ files, blob, original, json }) ?? [
    {
      path: files[0].path,
      before: { blob: original.sha256, mode: 'file' },
      after: { blob: blob.sha256, mode: 'file', content: { object: blob, recipe: null } },
    },
  ];
  const pages = buildSavePages(delta);
  for (const page of pages.pages) json(page.value);
  const plan = {
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: { object: baseline, recipe: null },
    pages: pages.root,
    pageCount: pages.pages.length,
    changeCount: delta.length,
    message: 'saved',
    at,
  };
  const input = json(plan);
  const io = {
    prepareRead: async pins => {
      assert(pins.length <= 100);
      windows.push(pins);
    },
    describeBatch: async ids =>
      ids.map(id => ({ object: { sha256: id, size: objects.get(id).length }, recipe: null })),
    read: async pin => {
      reads.push(pin);
      return (async function* () {
        yield objects.get(pin.sha256);
      })();
    },
    upload: async (pin, stream) => {
      const parts = [];
      for await (const part of stream) parts.push(part);
      const bytes = Buffer.concat(parts);
      assert.deepEqual(put(bytes), pin);
      writes.push(pin);
    },
  };
  return { input, plan, json, io, objects, reads, writes, windows, baseline, original, blob };
}

test('one-window V8 save has the exact resumable worker result on a 28,000-file baseline', async t => {
  const s = fixture(28000),
    before = process.memoryUsage().heapUsed;
  const result = await runSmallSourceSave(s.input, s.io);
  assert(result);
  assert.equal(s.windows.length, 2);
  assert.equal(s.reads.length, 4, 'input, baseline, delta page, one changed blob');
  assert.equal(s.writes.length, 2, 'State and result manifest only');
  const heapGrowth = process.memoryUsage().heapUsed - before;
  let cursor = initialSourceStep(s.input);
  do {
    cursor = (await runSourceStep(cursor, s.io)).cursor;
  } while (cursor.phase !== 'done');
  assert.deepEqual(result, cursor.output);
  assert(heapGrowth < 48 * 1024 * 1024, `heap growth ${heapGrowth}`);
  t.diagnostic(
    JSON.stringify({ baselineBytes: s.baseline.size, heapGrowth, metadataWindows: 2, outputObjects: 2 }),
  );
});

test('mode, rename, deletion and unchanged saves preserve native State bytes without rereading registered blobs', async () => {
  for (const kind of ['mode', 'rename', 'delete', 'unchanged']) {
    const s = fixture(20, ({ files, original }) => {
      const old = { blob: original.sha256, mode: 'file' },
        after = {
          ...old,
          mode: kind === 'mode' ? 'executable' : 'file',
          content: { object: original, recipe: null },
        };
      return kind === 'rename'
        ? [
            { path: files[0].path, before: old, after: null },
            { path: 'src/z.txt', before: null, after },
          ]
        : [{ path: files[0].path, before: old, after: kind === 'delete' ? null : after }];
    });
    const result = await runSmallSourceSave(s.input, s.io);
    assert(!s.reads.some(pin => pin.sha256 === s.original.sha256));
    let cursor = initialSourceStep(s.input);
    do {
      cursor = (await runSourceStep(cursor, s.io)).cursor;
    } while (cursor.phase !== 'done');
    assert.deepEqual(result, cursor.output, kind);
  }
});

test('oversized and recipe saves fall back before writing anything; corrupt and stale deltas fail', async () => {
  const s = fixture();
  for (const patch of [
    { baseline: { object: { ...s.baseline, size: smallSaveStateBytes + 1 }, recipe: null } },
    { baseline: { object: s.baseline, recipe: s.baseline } },
    { pageCount: 2 },
  ]) {
    assert.equal(await runSmallSourceSave(s.json({ ...s.plan, ...patch }), s.io), null);
    assert.equal(s.writes.length, 0);
  }
  s.objects.set(s.blob.sha256, new TextEncoder().encode('corrupt\n'));
  await assert.rejects(runSmallSourceSave(s.input, s.io), e => e.code === 'SOURCE_HASH_MISMATCH');
  assert.equal(s.writes.length, 0);
  const stale = fixture(20, ({ files, blob }) => [
    { path: files[0].path, before: { blob: blob.sha256, mode: 'file' }, after: null },
  ]);
  await assert.rejects(runSmallSourceSave(stale.input, stale.io), e => e.code === 'WORK_STALE');
  assert.equal(stale.writes.length, 0);
});

test('ten concurrent small saves keep two descriptor windows each and preserve every tree', async t => {
  const saves = Array.from({ length: 10 }, () => fixture(4000));
  const results = await Promise.all(saves.map(s => runSmallSourceSave(s.input, s.io)));
  for (let i = 0; i < saves.length; i++) {
    const s = saves[i],
      result = results[i];
    assert(result);
    assert.equal(s.windows.length, 2);
    assert.equal(s.reads.length, 4);
    assert.equal(s.writes.length, 2);
    const manifest = JSON.parse(new TextDecoder().decode(s.objects.get(result.sha256)));
    const state = JSON.parse(new TextDecoder().decode(s.objects.get(manifest.state.sha256)));
    assert.equal(state.files.length, 4000);
    assert.equal(state.files[0].blob, s.blob.sha256);
    assert.equal(state.files.at(-1).blob, s.original.sha256);
  }
  t.diagnostic(JSON.stringify({ saves: 10, descriptorWindowsPerSave: 2, readsPerSave: 4, writesPerSave: 2 }));
});

test('a near-4-MiB baseline fits the runtime memory budget under a constrained heap', t => {
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=40',
      '--max-semi-space-size=2',
      fileURLToPath(new URL('./hosted-source-small-save-memory.mjs', import.meta.url)),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert(metrics.baselineBytes < smallSaveStateBytes);
  assert(metrics.heapUsed + metrics.arrayBuffers < 64 * 1024 * 1024, JSON.stringify(metrics));
  t.diagnostic(JSON.stringify(metrics));
});

test('State and manifest uploads overlap, but a failed write prevents a successful result', async () => {
  for (const fail of [false, true]) {
    const s = fixture(4000),
      upload = s.io.upload;
    let started,
      release,
      calls = 0;
    const firstStarted = new Promise(resolve => {
      started = resolve;
    });
    const blocked = new Promise(resolve => {
      release = resolve;
    });
    s.io.upload = async (pin, stream) => {
      calls++;
      if (calls === 1) {
        started();
        await blocked;
        if (fail) throw Error('synthetic State upload failure');
      }
      return upload(pin, stream);
    };
    const saving = runSmallSourceSave(s.input, s.io);
    let settled = false;
    saving.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await firstStarted;
      assert.equal(calls, 2, 'manifest upload starts while the State upload is pending');
      assert.equal(settled, false, 'save cannot succeed before both writes settle');
    } finally {
      release();
    }
    if (fail) await assert.rejects(saving, /synthetic State upload failure/);
    else assert(await saving);
  }
});
