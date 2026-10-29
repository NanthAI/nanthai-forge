// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { SourceStepHash } from '../dist/hosted-source-step-hash.js';
import { saveBytes, buildSavePages } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { digest } from '../dist/hash.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
const at = '2026-01-01T00:00:00.000Z';
function fixture() {
  const objects = new Map(),
    describes = [],
    reads = [],
    uploads = [];
  const put = b => {
    b = Buffer.from(b);
    const p = { sha256: digest(b), size: b.length };
    objects.set(p.sha256, b);
    return p;
  };
  const json = v => put(saveBytes(v));
  const io = {
    async describeBatch(ids) {
      describes.push(ids);
      assert(ids.length <= 100);
      return ids.map(id => ({ object: { sha256: id, size: objects.get(id).length }, recipe: null }));
    },
    async read(p) {
      reads.push(p);
      const b = objects.get(p.sha256);
      assert(b);
      return (async function* () {
        for (let i = 0; i < b.length; i += 65536) yield b.subarray(i, i + 65536);
      })();
    },
    async upload(p, stream) {
      const parts = [];
      for await (const c of stream) parts.push(c);
      assert.deepEqual(put(Buffer.concat(parts)), p);
      uploads.push(p);
    },
  };
  const state = (files, parents = []) =>
    json({ schema: 1, kind: 'forge-source-state', parents, files, message: 'seed', at });
  const save = (baseline, changes) => {
    const p = buildSavePages(changes);
    for (const page of p.pages) json(page.value);
    return json({
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: baseline, recipe: null },
      pages: p.root,
      pageCount: p.pages.length,
      changeCount: changes.length,
      message: 'saved',
      at,
    });
  };
  return { objects, put, json, state, save, io, reads, uploads, describes };
}
async function isolatedStep(x, cursor) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./convex-source-step-child.mjs', import.meta.url))],
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const out = [],
    errors = [];
  child.stdout.on('data', b => out.push(b));
  child.stderr.on('data', b => errors.push(b));
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(Error(Buffer.concat(errors).toString()))));
  });
  child.stdin.end(
    JSON.stringify({ cursor, objects: [...x.objects].map(([id, b]) => [id, b.toString('base64')]) }),
  );
  await ended;
  const result = JSON.parse(Buffer.concat(out).toString());
  if (result.error) throw Object.assign(Error(result.error.message), result.error);
  for (const [id, b] of result.uploads) x.objects.set(id, Buffer.from(b, 'base64'));
  x.reads.push(...result.reads);
  return result.result;
}
async function drain(x, input, retry = false, isolated = true) {
  let c = initialSourceStep(input);
  const metrics = [];
  for (let count = 0; c.phase !== 'done'; count++) {
    assert(count < 1000, 'finite continuations');
    const before = structuredClone(c),
      run = value => (isolated ? isolatedStep(x, value) : runSourceStep(value, x.io)),
      result = await run(c);
    assert.deepEqual(c, before, 'step does not mutate its durable input');
    if (retry)
      assert.deepEqual((await run(before)).cursor, result.cursor, 'lost step reply replays exact progress');
    c = JSON.parse(JSON.stringify(result.cursor));
    metrics.push(result.metrics);
    assert(
      result.metrics.maxRssBytes < 400 * 1024 * 1024,
      `process peak RSS budget: ${JSON.stringify(result.metrics)}`,
    );
    assert(result.metrics.elapsedMs < 60000, 'step wall budget');
  }
  return { cursor: c, metrics };
}
test('durable SHA state survives arbitrary block boundaries, including empty content', () => {
  for (const length of [0, 1, 63, 64, 65, 65539]) {
    const b = Buffer.alloc(length, 37);
    let hash = new SourceStepHash();
    for (let i = 0; i < b.length; i += 17) {
      hash.update(b.subarray(i, i + 17));
      hash = new SourceStepHash(JSON.parse(JSON.stringify(hash.snapshot())));
    }
    assert.equal(hash.hex(), createHash('sha256').update(b).digest('hex'));
  }
});
test('10-file save matches fixed native worker and retries every step without changing output', async t => {
  const x = fixture(),
    files = Array.from({ length: 10 }, (_, i) => ({
      path: `f-${i}`,
      mode: 'file',
      blob: x.put(`old-${i}`).sha256,
    })),
    baseline = x.state(files);
  const changes = files.map(f => {
    const p = x.put(`process.exit(91); // repository remains bytes ${f.path}`);
    return {
      path: f.path,
      before: { blob: f.blob, mode: f.mode },
      after: { blob: p.sha256, mode: f.mode, content: { object: p, recipe: null } },
    };
  });
  const input = x.save(baseline, changes),
    expected = await buildHostedSourceState(input, x.io);
  const result = await drain(x, input, true);
  assert.equal(result.cursor.head, expected.head);
  assert.deepEqual(result.cursor.output, expected.output);
  assert.equal(result.metrics.length, 1, 'typical delta uses one bounded action');
  t.diagnostic(JSON.stringify({ steps: result.metrics.length, ...result.metrics[0] }));
});
test('26,000-file State and a 64 MiB recipe save use bounded resumable verification', async t => {
  const x = fixture(),
    leaf = x.put(Buffer.alloc(1024 * 1024, 98)),
    hash = createHash('sha256');
  for (let i = 0; i < 64; i++) hash.update(x.objects.get(leaf.sha256));
  const object = { sha256: hash.digest('hex'), size: 64 * leaf.size },
    tree = x.json({
      schema: 1,
      kind: 'forge-byte-tree',
      children: Array.from({ length: 64 }, () => ({ ...leaf, height: 0, length: leaf.size })),
    });
  const recipe = x.json({
    schema: 1,
    kind: 'forge-object-recipe',
    object,
    tree: { ...tree, height: 1, length: object.size },
  });
  const old = x.put('old'),
    files = Array.from({ length: 26000 }, (_, i) => ({
      path: `src/${String(i).padStart(6, '0')}`,
      mode: 'file',
      blob: old.sha256,
    })),
    baseline = x.state(files);
  const f = files[0],
    input = x.save(baseline, [
      {
        path: f.path,
        before: { blob: f.blob, mode: f.mode },
        after: { blob: object.sha256, mode: 'file', content: { object, recipe } },
      },
    ]);
  const result = await drain(x, input, true, true),
    state = JSON.parse(x.objects.get(result.cursor.head));
  assert.equal(state.files.length, 26000);
  assert.equal(state.files[0].blob, object.sha256);
  assert(result.metrics.length >= 8 && result.metrics.length <= 11);
  assert(result.metrics.slice(0, -1).every(m => m.bytes <= 8 * 1024 * 1024));
  assert(
    x.reads.every(p => p.size < 5 * 1024 * 1024),
    'large logical file is never a raw buffer',
  );
  t.diagnostic(
    JSON.stringify({
      steps: result.metrics.length,
      physicalReads: x.reads.length,
      maxStepBytes: Math.max(...result.metrics.map(m => m.bytes)),
      peakRss: Math.max(...result.metrics.map(m => m.maxRssBytes)),
      maxStepMs: Math.max(...result.metrics.map(m => m.elapsedMs)),
    }),
  );
});
test('paged register-state verifies every required parent and file, rejects corruption and cycles', async () => {
  const x = fixture(),
    blob = x.put('bytes'),
    files = Array.from({ length: 25001 }, (_, i) => ({
      path: `p/${String(i).padStart(6, '0')}`,
      mode: 'file',
      blob: blob.sha256,
    }));
  const parent = x.state([files[0]]),
    refs = [
      { object: blob, recipe: null },
      { object: parent, recipe: null },
    ];
  let next = null;
  for (let i = files.length; i > 0; i -= 100)
    next = x.json({
      schema: 1,
      kind: 'forge-source-worker-page',
      files: files.slice(Math.max(0, i - 100), i),
      objects: i === files.length ? refs : [],
      next,
    });
  const input = x.json({
    schema: 1,
    kind: 'forge-source-worker-state',
    parents: [parent.sha256],
    message: 'registered',
    at,
    pages: next,
  });
  const result = await drain(x, input);
  assert.equal(JSON.parse(x.objects.get(result.cursor.head)).files.length, 25001);
  x.objects.set(blob.sha256, Buffer.from('broken'));
  await assert.rejects(drain(x, input), e => e.code === 'SOURCE_HASH_MISMATCH');
  const cyclic = { schema: 1, kind: 'forge-source-worker-page', files: [], objects: [], next: null };
  const p = x.json(cyclic);
  x.objects.set(p.sha256, saveBytes({ ...cyclic, next: p }));
  await assert.rejects(
    drain(
      x,
      x.json({ schema: 1, kind: 'forge-source-worker-state', parents: [], message: 'bad', at, pages: p }),
    ),
    e => e.code === 'SOURCE_HASH_MISMATCH',
  );
});
test('compose and sync preserve byte-identical native results with compact ancestry and changed-byte windows', async t => {
  const x = fixture(),
    file = (path, text) => ({ path, mode: 'file', blob: x.put(text).sha256 });
  let base = x.state([file('a', 'a\nb\nc\n')]);
  for (let i = 0; i < 110; i++) base = x.state([file('a', 'a\nb\nc\n')], [base.sha256]);
  const left = x.state([file('a', 'A\nb\nc\n')], [base.sha256]),
    right = x.state([file('a', 'a\nb\nC\n')], [base.sha256]);
  const inputs = buildComposePages([
      {
        laneId: randomUUID(),
        head: right.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: right, recipe: null },
      },
    ]),
    dependencies = buildComposePages([]);
  for (const p of [...inputs.pages, ...dependencies.pages]) x.json(p.value);
  const plans = [
    {
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: left.sha256, receiptId: 'main' },
      main: { object: left, recipe: null },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'merge',
      at,
    },
    {
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
      message: 'merge',
      at,
    },
  ];
  for (const plan of plans) {
    const input = x.json(plan),
      expected = await buildHostedSourceState(input, x.io),
      actual = await drain(x, input, true);
    assert.equal(actual.cursor.head, expected.head);
    assert.deepEqual(actual.cursor.output, expected.output);
    t.diagnostic(JSON.stringify({ kind: plan.kind, steps: actual.metrics.length }));
  }
});

test('one direct saved child composes in one action without retained-history reads', async () => {
  const x = fixture(),
    blob = x.put('original'),
    file = { path: 'a', mode: 'file', blob: blob.sha256 };
  let old = x.state([file]);
  const retained = [];
  for (let i = 0; i < 150; i++) {
    retained.push(old.sha256);
    old = x.state([file], [old.sha256]);
  }
  const right = x.state([file, { ...file, path: 'new' }], [old.sha256]),
    inputs = buildComposePages([
      {
        laneId: randomUUID(),
        head: right.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: right, recipe: null },
      },
    ]),
    dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) x.json(page.value);
  const input = x.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: old.sha256, receiptId: 'main' },
    main: { object: old, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'merge',
    at,
  });
  const result = await drain(x, input, true);
  assert.equal(result.cursor.head, right.sha256);
  assert.equal(result.metrics.length, 1);
  assert(!x.reads.some(pin => retained.includes(pin.sha256)));
});
test('bounded dependency-first composition and conflict manifests match the fixed worker', async () => {
  for (const conflict of [false, true]) {
    const x = fixture(),
      file = (path, text) => ({ path, mode: 'file', blob: x.put(text).sha256 }),
      base = x.state([file('a', 'original')]);
    const dep = x.state([file('a', conflict ? 'dep' : 'original'), file('dep', 'dependency')], [base.sha256]),
      lane = x.state([file('a', conflict ? 'lane' : 'original'), file('lane', 'input')], [base.sha256]);
    const dependencies = buildComposePages([
        { candidateId: randomUUID(), head: dep.sha256, state: { object: dep, recipe: null } },
      ]),
      inputs = buildComposePages([
        {
          laneId: randomUUID(),
          head: lane.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: { object: lane, recipe: null },
        },
      ]);
    for (const page of [...dependencies.pages, ...inputs.pages]) x.json(page.value);
    const input = x.json({
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: base.sha256, receiptId: 'main' },
      main: { object: base, recipe: null },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'merge',
      at,
    });
    const expected = await buildHostedSourceState(input, x.io),
      actual = await drain(x, input, true);
    assert.deepEqual(actual.cursor.output, expected.output);
    assert.equal(actual.cursor.head, expected.head);
  }
});

test('32,000-object progress reuses compressed immutable sections instead of rewriting them per step', async t => {
  const c = initialSourceStep({ sha256: 'a'.repeat(64), size: 1 }),
    objects = new Map();
  let writes = 0,
    storedBytes = 0;
  for (let i = 0; i < 32000; i++) {
    const id = digest(`object-${i}`);
    c.inventory[id] = { object: { sha256: id, size: 17 }, recipe: null };
    c.queue.push(id);
    c.seen[id] = true;
  }
  const store = async bytes => {
    const id = `progress-${writes++}`;
    objects.set(id, bytes);
    storedBytes += bytes.length;
    return id;
  };
  const initial = await saveSourceProgress(c, null, store),
    firstBytes = storedBytes,
    firstWrites = writes;
  c.queueIndex = 100;
  const next = await saveSourceProgress(c, initial.value, store);
  assert.equal(writes - firstWrites, 1, 'advancing a verification window writes only the small cursor');
  assert(storedBytes - firstBytes < 8192, 'cursor write budget is independent of object count');
  assert.deepEqual(next.value.sections, initial.value.sections);
  const restored = await loadSourceProgress(objects.get(next.id), async id => objects.get(id));
  assert.deepEqual(restored.cursor, c);
  const id = next.value.sections.inventory.id;
  objects.set(id, Buffer.from('corrupt'));
  await assert.rejects(
    loadSourceProgress(objects.get(next.id), async id => objects.get(id)),
    e => e.code === 'SOURCE_HASH_MISMATCH',
  );
  t.diagnostic(
    JSON.stringify({
      objects: 32000,
      initialSectionWrites: firstWrites,
      initialCompressedBytes: firstBytes,
      nextStepWrites: writes - firstWrites,
      nextStepBytes: storedBytes - firstBytes,
    }),
  );
});

test('20 selected Lanes share a bounded action and metadata windows', async () => {
  const x = fixture(),
    blob = x.put('shared'),
    file = { path: 'shared', mode: 'file', blob: blob.sha256 },
    base = x.state([file]);
  const entries = Array.from({ length: 20 }, (_, i) => {
    const head = x.state([file, { ...file, path: `lane-${i}` }], [base.sha256]);
    return {
      laneId: randomUUID(),
      head: head.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: head, recipe: null },
    };
  });
  const inputs = buildComposePages(entries),
    dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) x.json(page.value);
  const input = x.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: base.sha256, receiptId: 'main' },
    main: { object: base, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'merge',
    at,
  });
  const expected = await buildHostedSourceState(input, x.io),
    actual = await drain(x, input, true);
  assert.deepEqual(actual.cursor.output, expected.output);
  assert.equal(actual.metrics.length, 1, 'small merge inputs batch within the object/byte budget');
});
test('journaled virtual-base merges retain native recursive results and file/directory alternatives', async () => {
  for (const pathClash of [false, true]) {
    const x = fixture(),
      file = (text, path = 'f') => ({ path, mode: 'file', blob: x.put(text).sha256 });
    const root = x.state([file('a\nb\nc\nd\ne\nf\ng\n')]);
    const a = x.state([file('A\nb\nc\nd\ne\nf\ng\n')], [root.sha256]),
      b = x.state([file('a\nb\nc\nd\ne\nf\nG\n', pathClash ? 'f/child' : 'f')], [root.sha256]);
    const left = x.state([file('A\nb\nC\nd\ne\nf\nG\n')], [a.sha256, b.sha256]),
      right = x.state([file('A\nb\nc\nd\nE\nf\nG\n', pathClash ? 'f/child' : 'f')], [b.sha256, a.sha256]);
    const input = x.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
      message: 'merge',
      at,
    });
    const expected = await buildHostedSourceState(input, x.io),
      actual = await drain(x, input, true);
    assert.equal(actual.cursor.head, expected.head);
    assert.deepEqual(actual.cursor.output, expected.output);
  }
});
test('streamed resolution-marker scans match native regex across chunks and recipe continuations', async () => {
  const { runSourceTask } = await import('../dist/hosted-source-fanout.js');
  for (const text of [
    'clean\n',
    '=======',
    '=======\r',
    '=======\r\n',
    '=======no\n',
    'x\n<<<<<<< lane\n',
    'x>>>>>>> no',
    'x\n>>>>>>> target',
  ]) {
    const x = fixture(),
      pin = x.put(text),
      file = { path: 'f', mode: 'file', blob: pin.sha256 };
    const result = await runSourceTask(
      {
        kind: 'markers',
        request: {
          key: 'scan',
          kind: 'markers',
          item: { path: 'f', left: file },
          order: 'right-first',
          channel: 'target',
        },
        refs: [{ object: pin, recipe: null }],
      },
      null,
      x.io,
    );
    assert.equal(
      result.progress.calculations[0].markers,
      /^(<<<<<<< |>>>>>>> |=======\r?$)/m.test(text),
      JSON.stringify(text),
    );
  }
  const x = fixture(),
    bytes = Buffer.alloc(12 * 1024 * 1024, 10);
  Buffer.from('<<<<<<< lane\n').copy(bytes, 8 * 1024 * 1024 - 4);
  const { buildObjectRecipe } = await import('../dist/object-chunks.js'),
    built = buildObjectRecipe(bytes);
  for (const [id, b] of built.objects) x.objects.set(id, b);
  const recipe = x.put(built.bytes),
    object = { sha256: digest(bytes), size: bytes.length },
    file = { path: 'large', mode: 'file', blob: object.sha256 };
  const input = {
    kind: 'markers',
    request: {
      key: 'scan',
      kind: 'markers',
      item: { path: 'large', left: file },
      order: 'right-first',
      channel: 'target',
    },
    refs: [{ object, recipe }],
  };
  let previous = null,
    result,
    steps = 0;
  do {
    result = await runSourceTask(input, previous, x.io);
    previous = JSON.parse(JSON.stringify(result.progress));
    steps++;
  } while (!result.done);
  assert(steps > 1);
  assert.equal(result.progress.calculations[0].markers, true);
});
