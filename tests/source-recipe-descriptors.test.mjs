// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { digest } from '../dist/hash.js';
import { MemoryMergeSource, MemorySourceReader } from '../dist/hosted-source-memory.js';
import { SourceWorkerReader } from '../dist/hosted-source-worker-reader.js';
import { sourceStateLimits } from '../dist/source-state-size.js';
import speedBudgets from '../src/speed-budgets.json' with { type: 'json' };

const sharedBlob = digest('synthetic');
const bytes = Buffer.from(
  JSON.stringify({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: Array.from({ length: 29000 }, (_, i) => ({
      path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
      mode: 'file',
      blob: sharedBlob,
    })),
    message: 'synthetic recipe-backed State',
    at: '2026-01-01T00:00:00.000Z',
  }),
);
const built = buildObjectRecipe(bytes);
const logical = { sha256: digest(bytes), size: bytes.length };
const recipe = { sha256: digest(built.bytes), size: built.bytes.length };

function fixture(
  t,
  kind,
  { batching = true, corrupt = false, deny = false, input = { bytes, built, logical, recipe } } = {},
) {
  const { bytes, built, logical, recipe } = input;
  const root = mkdtempSync(join(tmpdir(), 'forge-recipe-descriptors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const objects = new Map(built.objects);
  objects.set(recipe.sha256, built.bytes);
  const described = new Set();
  let windows = 0,
    reads = 0;
  const prepare = async pins => {
    assert.ok(pins.length <= 100, 'recipe descriptor windows retain the existing page bound');
    if (deny) throw Object.assign(new Error('Current source access denied'), { code: 'PROJECT_UNAVAILABLE' });
    const missing = pins.filter(pin => !described.has(pin.sha256));
    if (missing.length) windows++;
    for (const pin of missing) {
      assert.equal(objects.get(pin.sha256)?.length, pin.size);
      described.add(pin.sha256);
    }
  };
  const io = {
    ...(batching ? { prepareRead: prepare } : {}),
    async read(pin) {
      if (!described.has(pin.sha256)) await prepare([pin]);
      reads++;
      let body = objects.get(pin.sha256);
      if (corrupt && pin.sha256 !== recipe.sha256 && pin.sha256 !== built.recipe.tree.sha256) {
        body = Buffer.from(body);
        body[0] ^= 1;
      }
      return (async function* () {
        yield body;
      })();
    },
    async upload() {
      throw Error('Reading a recipe must not write source');
    },
  };
  const reader =
    kind === 'memory'
      ? new MemorySourceReader(new MemoryMergeSource({}), io)
      : new SourceWorkerReader(root, io);
  return {
    async read() {
      const ref = { object: logical, recipe };
      return kind === 'memory' ? reader.bytes(ref) : readFileSync(await reader.file(ref));
    },
    reader,
    counts: () => ({ windows, reads }),
  };
}

function manyLeaves() {
  const chunks = Array.from({ length: 128 }, (_, i) => Buffer.alloc(65536, i));
  const children = chunks.map(bytes => ({
    sha256: digest(bytes),
    size: bytes.length,
    length: bytes.length,
    height: 0,
  }));
  const page = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }));
  const bytes = Buffer.concat(chunks);
  const logical = { sha256: digest(bytes), size: bytes.length };
  const value = {
    kind: 'forge-object-recipe',
    schema: 1,
    object: logical,
    tree: { sha256: digest(page), size: page.length, length: bytes.length, height: 1 },
  };
  const recipeBytes = Buffer.from(JSON.stringify(value));
  const objects = new Map(chunks.map(bytes => [digest(bytes), bytes]));
  objects.set(digest(page), page);
  return {
    bytes,
    logical,
    recipe: { sha256: digest(recipeBytes), size: recipeBytes.length },
    built: { objects, recipe: value, bytes: recipeBytes },
  };
}

for (const kind of ['memory', 'file']) {
  test(`${kind} source reader batches legacy recipe descriptors for a 29k State without changing bytes`, async t => {
    const f = fixture(t, kind);
    assert.deepEqual(await f.read(), bytes);
    t.diagnostic(
      JSON.stringify({ logicalBytes: bytes.length, physicalObjects: built.objects.size + 1, ...f.counts() }),
    );
    assert.ok(f.counts().windows <= 3, 'recipe, root page and one leaf window; never one RPC per leaf');
  });
  test(`${kind} source recipe windows stay batched beyond the first 100 distinct leaves`, async t => {
    const input = manyLeaves(),
      f = fixture(t, kind, { input });
    assert.deepEqual(await f.read(), input.bytes);
    t.diagnostic(JSON.stringify(f.counts()));
    assert.ok(f.counts().windows <= 4, 'recipe, index and two leaf windows; no sliding one-leaf RPCs');
  });
  test(`${kind} recipe batching still rejects a corrupted leaf`, async t => {
    await assert.rejects(fixture(t, kind, { corrupt: true }).read(), { code: 'SOURCE_HASH_MISMATCH' });
  });
  test(`${kind} recipe batching propagates current-access failures`, async t => {
    const f = fixture(t, kind, { deny: true });
    await assert.rejects(f.read(), { code: 'PROJECT_UNAVAILABLE' });
    assert.equal(f.counts().reads, 0);
  });
  test(`${kind} recipe reader still supports a transport without descriptor preparation`, async t => {
    const f = fixture(t, kind, { batching: false });
    assert.deepEqual(await f.read(), bytes);
    t.diagnostic(JSON.stringify({ unbatchedDescriptorWindows: f.counts().windows }));
  });
}

test('legacy recipe retains one backing allocation per logical State and reuses verified leaves', async t => {
  const f = fixture(t, 'memory');
  const actual = await f.read();
  const before = f.counts();
  const source = f.reader.source;
  assert(
    source.inputBytes() <=
      bytes.length +
        speedBudgets.budgets.find(value => value.id === 'source-recipe-retained-extra-bytes').max,
    'no duplicate retained recipe bodies',
  );
  for (const [id, value] of built.objects) {
    const cached = source.objects.get(id);
    assert.deepEqual(cached, value);
    if (value.length > 64 * 1024) {
      assert.equal(cached.buffer, actual.buffer, 'verified leaf is a view into the assembled State');
      assert.deepEqual(
        await f.reader.bytes({ object: { sha256: id, size: value.length }, recipe: null }),
        value,
      );
    }
  }
  assert.deepEqual(await f.read(), bytes);
  assert.deepEqual(
    f.counts(),
    before,
    'logical and leaf cache hits perform no extra reads or descriptor calls',
  );
});

for (const [phase, limit] of Object.entries(sourceStateLimits))
  test(`${phase} legacy recipe at its manifest-byte envelope retains no duplicate physical payload`, async t => {
    const files = Array.from(
      { length: Math.min(limit.fileCount, Math.floor((limit.manifestBytes - 512) / 162)) },
      (_, i) => ({
        path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
        mode: 'file',
        blob: sharedBlob,
      }),
    );
    const value = {
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: '',
      at: '2026-01-01T00:00:00.000Z',
    };
    const size = Buffer.byteLength(JSON.stringify(value));
    assert(size <= limit.manifestBytes);
    value.message = 'x'.repeat(limit.manifestBytes - size);
    const bytes = Buffer.from(JSON.stringify(value)),
      built = buildObjectRecipe(bytes),
      logical = { sha256: digest(bytes), size: bytes.length },
      recipe = { sha256: digest(built.bytes), size: built.bytes.length };
    const f = fixture(t, 'memory', { input: { bytes, built, logical, recipe } });
    assert.deepEqual(await f.read(), bytes);
    assert.equal(bytes.length, limit.manifestBytes);
    assert(
      f.reader.source.inputBytes() <=
        bytes.length +
          speedBudgets.budgets.find(value => value.id === 'source-recipe-retained-extra-bytes').max,
    );
    t.diagnostic(
      JSON.stringify({
        phase,
        files: files.length,
        logicalBytes: bytes.length,
        retainedBytes: f.reader.source.inputBytes(),
        reads: f.counts(),
      }),
    );
  });
