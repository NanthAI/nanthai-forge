// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { saveBytes, savePin, buildSavePages } from '../dist/hosted-save.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { digest } from '../dist/hash.js';
async function run(s, changes, modify = plan => plan) {
  const pages = buildSavePages(changes);
  for (const page of pages.pages) s.put(saveBytes(page.value));
  const plan = modify({
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: { object: s.baseline, recipe: null },
    pages: pages.root,
    pageCount: pages.pages.length,
    changeCount: changes.length,
    message: 'synthetic',
    at: '2026-01-02T00:00:00.000Z',
  });
  const input = s.put(saveBytes(plan));
  let uploads = 0;
  return buildHostedSourceState(input, {
    async read(pin) {
      assert(s.objects.has(pin.sha256));
      return [s.objects.get(pin.sha256)];
    },
    async upload(pin, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(s.put(Buffer.concat(chunks)), pin);
      uploads++;
    },
  }).catch(error => {
    assert.equal(uploads, 0, 'validation failures publish nothing');
    throw error;
  });
}
test('worker rejects a fabricated before pin and source path overlap without output', async () => {
  const s = await saveFixture(),
    change = s.change();
  await assert.rejects(run(s, [{ ...change, before: null }]), e => e.code === 'WORK_STALE');
  const addition = { ...change, path: 'a.txt/child', before: null };
  await assert.rejects(run(s, [addition]), e => e.code === 'INVALID_NATIVE_SOURCE');
});
test('worker verifies exact changed bytes and complete page counts', async () => {
  const s = await saveFixture(),
    change = s.change();
  const pin = change.after.content.object;
  s.objects.set(pin.sha256, Buffer.from('corruption'));
  await assert.rejects(run(s, [change]), e => e.code === 'SOURCE_HASH_MISMATCH');
  s.objects.set(pin.sha256, Buffer.from('changed'));
  await assert.rejects(
    run(s, [change], plan => ({ ...plan, changeCount: 2 })),
    e => e.code === 'SOURCE_CLOSURE_INVALID',
  );
});
test('mode-only save reuses blob identity and exact parent/time pins; identical delta keeps head', async () => {
  const s = await saveFixture();
  const original = {
    path: 'a.txt',
    before: { blob: s.original.sha256, mode: 'file' },
    after: { blob: s.original.sha256, mode: 'executable', content: { object: s.original, recipe: null } },
  };
  const output = await run(s, [original]);
  const state = JSON.parse(s.objects.get(output.head));
  assert.deepEqual(state.parents, [s.baseline.sha256]);
  assert.equal(state.at, '2026-01-02T00:00:00.000Z');
  assert.equal(state.files.find(f => f.path === 'a.txt').mode, 'executable');
  const unchanged = await run(s, [{ ...original, after: { ...original.after, mode: 'file' } }]);
  assert.equal(unchanged.head, s.baseline.sha256);
  assert.equal(unchanged.metrics.uploads, 1);
});
test('128 MiB changed blob streams once; unchanged baseline bytes/history are not fetched', async t => {
  const s = await saveFixture(),
    chunk = Buffer.alloc(1024 * 1024, 0x42),
    hash = createHash('sha256');
  for (let i = 0; i < 128; i++) hash.update(chunk);
  const pin = { sha256: hash.digest('hex'), size: 128 * 1024 * 1024 };
  const change = {
    path: 'large.bin',
    before: null,
    after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
  };
  const built = buildSavePages([change]);
  s.put(saveBytes(built.pages[0].value));
  const plan = {
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: s.baseline, recipe: null },
      pages: built.root,
      pageCount: 1,
      changeCount: 1,
      message: 'large',
      at: '2026-01-02T00:00:00.000Z',
    },
    input = s.put(saveBytes(plan));
  const fetched = [];
  let sourceBytes = 0;
  const output = await buildHostedSourceState(input, {
    async read(ref) {
      fetched.push(ref.sha256);
      if (ref.sha256 === pin.sha256)
        return (async function* () {
          for (let i = 0; i < 128; i++) {
            sourceBytes += chunk.length;
            yield chunk;
          }
        })();
      return [s.objects.get(ref.sha256)];
    },
    async upload(ref, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(digest(bytes), ref.sha256);
    },
  });
  assert.equal(sourceBytes, pin.size);
  assert.equal(fetched.filter(id => id === pin.sha256).length, 1);
  assert(!fetched.includes(s.original.sha256) && !fetched.includes(s.hidden.sha256));
  assert.equal(output.metrics.maxChunkBytes, 1024 * 1024);
  t.diagnostic(JSON.stringify(output.metrics));
});
