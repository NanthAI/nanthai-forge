// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { NativeSource } from '../dist/native-source.js';
const at = '2026-01-01T00:00:00.000Z';
function plan(s, left, right) {
  const inputs = buildComposePages([
    {
      laneId: randomUUID(),
      head: right.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: right, recipe: null },
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const p of [...inputs.pages, ...dependencies.pages]) s.put(saveBytes(p.value));
  return {
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: left.sha256, receiptId: 'main-0' },
    main: { object: left, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'Native review composition',
    at,
  };
}
async function parity(t, s, left, right) {
  const root = mkdtempSync(join(tmpdir(), 'forge-hosted-merge-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const native = new NativeSource(root);
  for (const bytes of s.objects.values()) native.put(bytes);
  const original = new Map([...s.objects].map(([id, bytes]) => [id, Buffer.from(bytes)]));
  const expected = native.compose(left.sha256, right.sha256, 'Native review composition', at),
    output = await s.compute(plan(s, left, right));
  const result = JSON.parse(output.manifest).result;
  if (expected.head) {
    assert.equal(result.status, 'clean');
    assert.equal(result.state.sha256, expected.head);
  } else {
    assert.equal(result.status, 'conflict');
    const paths = [];
    let next = result.conflicts;
    while (next) {
      const page = JSON.parse(s.objects.get(next.sha256));
      assert.equal(page.left, left.sha256);
      assert.equal(page.right, right.sha256);
      paths.push(...page.paths);
      next = page.next;
    }
    assert.deepEqual(
      paths.map(p => p.path),
      [...new Set(expected.conflicts)].sort(),
    );
  }
  for (const [id, bytes] of original) assert.deepEqual(s.objects.get(id), bytes, 'original source retained');
  return output;
}
test('criss-cross recursive bases produce byte-identical native source and lazy shared cache', async t => {
  const s = await composeFixture(),
    file = text => s.file('f', text),
    state = (files, parents = []) => s.state(files, parents);
  const root = state([file('a\nb\nc\nd\ne\nf\ng\n'), s.hidden]);
  const a = state([file('A\nb\nc\nd\ne\nf\ng\n'), s.hidden], [root.sha256]);
  const b = state([file('a\nb\nc\nd\ne\nf\nG\n'), s.hidden], [root.sha256]);
  const left = state([file('A\nb\nC\nd\ne\nf\nG\n'), s.hidden], [a.sha256, b.sha256]);
  const right = state([file('A\nb\nc\nd\nE\nf\nG\n'), s.hidden], [b.sha256, a.sha256]);
  const output = await parity(t, s, left, right),
    merged = JSON.parse(s.objects.get(output.head));
  assert.equal(
    s.objects.get(merged.files.find(f => f.path === 'f').blob).toString(),
    'A\nb\nC\nd\nE\nf\nG\n',
  );
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  assert.equal(
    new Set(output.reads.map(p => p.sha256)).size,
    output.reads.length,
    'one physical download per exact object',
  );
  t.diagnostic(JSON.stringify(output.metrics));
});
test('stacked Lane and independently composed parent retain accepted main with the native merge', async t => {
  const s = await composeFixture();
  const parent = s.state([s.baseFile, s.hidden, s.file('parent', 'parent')], [s.baseline.sha256]);
  const stacked = s.state(
    [s.baseFile, s.hidden, s.file('parent', 'parent'), s.file('child', 'child')],
    [parent.sha256],
  );
  const main = s.state([s.baseFile, s.hidden, s.file('main', 'accepted')], [s.baseline.sha256]);
  const first = await s.compute(plan(s, main, parent)),
    landed = { sha256: first.head, size: s.objects.get(first.head).length };
  const output = await parity(t, s, landed, stacked);
  assert.deepEqual(
    JSON.parse(s.objects.get(output.head)).files.map(f => f.path),
    ['a.txt', 'child', 'hidden.bin', 'main', 'parent'],
  );
});
for (const recursive of [false, true])
  for (const kind of ['text', 'binary', 'mode', 'delete', 'path', 'symlink']) {
    test(`${recursive ? 'recursive' : 'single'} ${kind} conflict preserves exact side and original base pins`, async t => {
      const s = await composeFixture(),
        original = s.file('f', kind === 'binary' ? 'base\0' : 'base\n');
      const root = s.state([original]),
        x =
          kind === 'mode'
            ? { ...original, mode: 'executable' }
            : s.file('f', kind === 'binary' ? 'left\0' : 'left\n', kind === 'symlink' ? 'symlink' : 'file'),
        y =
          kind === 'mode'
            ? { ...original, mode: 'symlink' }
            : s.file('f', kind === 'binary' ? 'right\0' : 'right\n', kind === 'symlink' ? 'symlink' : 'file');
      const xs = kind === 'delete' ? [] : [x],
        ys = kind === 'path' ? [s.file('f/child', 'child')] : [y];
      let left = s.state(xs, [root.sha256]),
        right = s.state(ys, [root.sha256]);
      if (recursive) {
        const a = left,
          b = right;
        left = s.state(xs, [a.sha256, b.sha256]);
        right = s.state(ys, [b.sha256, a.sha256]);
      }
      const output = await parity(t, s, left, right),
        result = JSON.parse(output.manifest).result;
      assert.equal(result.status, 'conflict');
      assert.equal(output.head, null);
      const first = JSON.parse(s.objects.get(result.conflicts.sha256));
      assert(first.paths.some(p => p.path === 'f'));
      assert.equal(first.left, left.sha256);
      assert.equal(first.right, right.sha256);
      if (!recursive) assert.deepEqual(first.paths.find(p => p.path === 'f').base, original);
    });
  }
test('conflict Candidates publish with paged data and can be pinned by H09 without moving source', async () => {
  const s = await composeFixture(),
    a = await s.lane(s.state([s.file('a.txt', 'left\n'), s.hidden], [s.baseline.sha256])),
    b = await s.lane(s.state([s.file('a.txt', 'right\n'), s.hidden], [s.baseline.sha256]));
  const x = s.selection([a, b]);
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x),
    candidate = (await s.publish(output)).outcome.result;
  assert.equal(candidate.result.status, 'conflict');
  const conflict = JSON.parse(s.objects.get(candidate.result.conflicts.sha256));
  assert.equal(conflict.left, a.head);
  assert.equal(conflict.right, b.head);
  assert.equal(conflict.paths[0].path, 'a.txt');
  assert.equal([...s.tables.projectHostedChannels.values()][0].selection, JSON.stringify(s.main));
});
test('250 conflict paths are linked in bounded pages', async () => {
  const s = await composeFixture(),
    original = [],
    a = [],
    b = [];
  for (let i = 0; i < 250; i++) {
    const path = `f${String(i).padStart(3, '0')}`;
    original.push(s.file(path, 'base\n'));
    a.push(s.file(path, 'left\n'));
    b.push(s.file(path, 'right\n'));
  }
  const root = s.state(original),
    left = s.state(a, [root.sha256]),
    right = s.state(b, [root.sha256]),
    output = await s.compute(plan(s, left, right));
  let next = JSON.parse(output.manifest).result.conflicts;
  const sizes = [];
  while (next) {
    const page = JSON.parse(s.objects.get(next.sha256));
    sizes.push(page.paths.length);
    assert(next.size < 128 * 1024);
    next = page.next;
  }
  assert.deepEqual(sizes, [100, 100, 50]);
});
test('unrelated roots, corrupt ancestry and incomplete manifests fail explicitly', async () => {
  const s = await composeFixture(),
    unrelated = s.state([], [], 'unrelated');
  await assert.rejects(
    s.compute(plan(s, s.baseline, unrelated)),
    e => e.code === 'NATIVE_MERGE_BASE_UNKNOWN',
  );
  const left = s.state([s.file('f', 'left')], [s.baseline.sha256]),
    right = s.state([s.file('f', 'right')], [s.baseline.sha256]);
  await assert.rejects(
    s.compute(plan(s, left, right), p => ({ ...p, inputs: { ...p.inputs, count: 2 } })),
    e => e.code === 'SOURCE_CLOSURE_INVALID',
  );
  s.objects.set(s.baseline.sha256, Buffer.from('fabricated parents'));
  await assert.rejects(s.compute(plan(s, left, right)), e => e.code === 'SOURCE_HASH_MISMATCH');
});
