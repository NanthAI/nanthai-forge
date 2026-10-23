// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { conflictPlan } from '../dist/agent-sync.js';
const at = '2026-01-01T00:00:00.000Z',
  message = 'Native sync parity';
const plan = (left, right) => ({
  schema: 1,
  kind: 'forge-hosted-sync-input',
  algorithm: 'forge-native-sync-v1',
  work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
  message,
  at,
});
async function parity(t, s, left, right) {
  const root = mkdtempSync(join(tmpdir(), 'forge-sync-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new NativeSource(root);
  for (const bytes of s.objects.values()) source.put(bytes);
  const merged = source.compose(left.sha256, right.sha256, message, at, { insertionOrder: 'right-first' });
  const output = await s.compute(plan(left, right)),
    result = JSON.parse(output.manifest).result;
  if (merged.head) {
    assert.equal(result.status, merged.head === left.sha256 ? 'up-to-date' : 'merged');
    assert.equal(result.state.sha256, merged.head);
  } else {
    const pending = conflictPlan(source, left.sha256, right.sha256, 'target');
    const files = pending.files.map(file => ({
      path: file.path,
      mode: file.mode,
      blob: file.bytes ? source.put(file.bytes) : file.blob,
    }));
    assert.equal(result.status, 'conflict');
    assert.equal(result.state.sha256, source.writeState(files, [left.sha256], message, at));
    assert.equal(result.left, left.sha256);
    assert.equal(result.right, right.sha256);
  }
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  return { output, result };
}
test('native right-first insertions and disjoint text edits are byte-identical', async t => {
  const s = await composeFixture();
  const left = s.state([s.file('a.txt', 'first\na\nX\nb\nc\n'), s.hidden], [s.baseline.sha256]);
  const right = s.state([s.file('a.txt', 'a\nY\nb\nc\nlast\n'), s.hidden], [s.baseline.sha256]);
  const { result } = await parity(t, s, left, right);
  assert.equal(result.status, 'merged');
  const file = JSON.parse(s.objects.get(result.state.sha256)).files.find(f => f.path === 'a.txt');
  assert.equal(s.objects.get(file.blob).toString(), 'first\na\nY\nX\nb\nc\nlast\n');
});
for (const recursive of [false, true])
  for (const kind of ['text', 'binary', 'mode', 'delete', 'path', 'symlink']) {
    test(`${recursive ? 'recursive' : 'single'} ${kind} draft uses local native conflict semantics`, async t => {
      const s = await composeFixture(),
        original = s.file('f', kind === 'binary' ? 'base\0' : 'base\n'),
        root = s.state([original, s.hidden]);
      const x =
          kind === 'mode'
            ? { ...original, mode: 'executable' }
            : s.file('f', kind === 'binary' ? 'left\0' : 'left\n', kind === 'symlink' ? 'symlink' : 'file'),
        y =
          kind === 'mode'
            ? { ...original, mode: 'symlink' }
            : s.file('f', kind === 'binary' ? 'right\0' : 'right\n', kind === 'symlink' ? 'symlink' : 'file');
      const xs = kind === 'delete' ? [s.hidden] : [x, s.hidden],
        ys = kind === 'path' ? [s.file('f/child', 'child'), s.hidden] : [y, s.hidden];
      let left = s.state(xs, [root.sha256]),
        right = s.state(ys, [root.sha256]);
      if (recursive) {
        const a = left,
          b = right;
        left = s.state(xs, [a.sha256, b.sha256]);
        right = s.state(ys, [b.sha256, a.sha256]);
      }
      const { result } = await parity(t, s, left, right);
      assert.equal(result.status, 'conflict');
    });
  }
test('250 conflict paths page automatically and fetch each affected object once', async t => {
  const s = await composeFixture(),
    original = [],
    l = [],
    r = [];
  for (let i = 0; i < 250; i++) {
    const path = `f${String(i).padStart(3, '0')}`;
    original.push(s.file(path, `base-${i}\n`));
    l.push(s.file(path, `left-${i}\n`));
    r.push(s.file(path, `right-${i}\n`));
  }
  const base = s.state([...original, s.hidden]),
    left = s.state([...l, s.hidden], [base.sha256]),
    right = s.state([...r, s.hidden], [base.sha256]);
  const { output, result } = await parity(t, s, left, right);
  let next = result.conflicts;
  const pages = [];
  while (next) {
    const page = JSON.parse(s.objects.get(next.sha256));
    pages.push(page.paths.length);
    assert(next.size < 128 * 1024);
    next = page.next;
  }
  assert.deepEqual(pages, [100, 100, 50]);
  assert.equal(new Set(output.reads.map(p => p.sha256)).size, output.reads.length);
  t.diagnostic(JSON.stringify({ ...output.metrics, conflictPages: pages }));
});
test('binary choose-left resolution is explicit even with unchanged file bytes', async () => {
  const s = await composeFixture(),
    root = s.state([s.file('f', 'base\0'), s.hidden]),
    left = s.state([s.file('f', 'left\0'), s.hidden], [root.sha256]),
    right = s.state([s.file('f', 'right\0'), s.hidden], [root.sha256]);
  const draft = await s.compute(plan(left, right)),
    conflict = JSON.parse(draft.manifest).result;
  const resolution = {
    candidateId: null,
    conflicts: conflict.conflicts,
    left: left.sha256,
    right: right.sha256,
    draftHead: conflict.state.sha256,
    status: 'pending',
  };
  const completed = await s.compute({
    ...plan(left, right),
    work: { mode: 'resolve', left: { object: conflict.state, recipe: null }, resolution },
  });
  const result = JSON.parse(completed.manifest).result,
    state = JSON.parse(s.objects.get(result.state.sha256));
  assert.equal(result.status, 'resolved');
  assert.equal(result.resolution.status, 'resolved');
  assert.deepEqual(state.parents, [conflict.state.sha256, right.sha256]);
  assert.equal(
    state.files.find(f => f.path === 'f').blob,
    JSON.parse(s.objects.get(left.sha256)).files.find(f => f.path === 'f').blob,
  );
});
test('unrelated roots, substituted drafts and corrupt ancestry fail without guessing source', async () => {
  const s = await composeFixture(),
    other = s.state([], [], 'unrelated');
  await assert.rejects(s.compute(plan(s.baseline, other)), e => e.code === 'NATIVE_MERGE_BASE_UNKNOWN');
  const left = s.state([s.file('f', 'left')], [s.baseline.sha256]),
    right = s.state([s.file('f', 'right')], [s.baseline.sha256]);
  const draft = await s.compute(plan(left, right)),
    result = JSON.parse(draft.manifest).result;
  await assert.rejects(
    s.compute({
      ...plan(left, right),
      work: {
        mode: 'resolve',
        left: { object: other, recipe: null },
        resolution: {
          candidateId: null,
          conflicts: result.conflicts,
          left: left.sha256,
          right: right.sha256,
          draftHead: result.state.sha256,
          status: 'pending',
        },
      },
    }),
    e => e.code === 'WORK_STALE',
  );
  s.objects.set(s.baseline.sha256, Buffer.from('corrupt'));
  await assert.rejects(s.compute(plan(left, right)), e => e.code === 'SOURCE_HASH_MISMATCH');
});
