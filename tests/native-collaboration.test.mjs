// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mergeNativeText } from '../dist/native-text-merge.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
const b = s => Buffer.from(s),
  merge = (base, left, right) => mergeNativeText(b(base), b(left), b(right));
test('native diff3 merges independent edits byte-exactly and retains overlapping/binary conflicts', () => {
  assert.equal(merge('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n').toString(), 'A\nb\nc\nD\n');
  assert.equal(merge('a\r\nb\r\nc', 'A\r\nb\r\nc', 'a\r\nb\r\nC').toString(), 'A\r\nb\r\nC');
  assert.equal(merge('a\nb\nc\nd\n', 'b\nc\nd\n', 'a\nb\nc\nd\ne\n').toString(), 'b\nc\nd\ne\n');
  assert.equal(merge('a\nb\n', 'a\nB\n', 'a\nB\n').toString(), 'a\nB\n');
  assert.equal(merge('a\nb\n', 'a\nB\n', 'a\nC\n'), null);
  assert.equal(merge('a\n', 'x\na\n', 'y\na\n'), null);
  assert.equal(merge('a\0b', 'a\0B', 'A\0b'), null);
  assert.equal(mergeNativeText(Buffer.from([255]), b('x'), b('y')), null);
  // Deterministic varied sequences catch reconstruction errors including repeated lines.
  let seed = 42;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 300; i++) {
    const base = Array.from({ length: next() % 35 }, () => String(next() % 5) + '\n').join(''),
      after = Array.from({ length: next() % 35 }, () => String(next() % 5) + '\n').join('');
    assert.equal(merge(base, after, base)?.toString(), after);
  }
});
test('native import merge coalesces identical additions at the same or different positions', () => {
  const base =
    "import { join } from 'node:path';\nimport { tmpdir } from 'node:os';\nexport const value = 1;\n";
  for (const statement of [
    "import { readFileSync } from 'node:fs';\n",
    "import type { Stats } from 'node:fs';\n",
    "import 'node:fs';\n",
  ]) {
    const left = statement + base;
    for (const right of [left, base.replace('export const', statement + 'export const')]) {
      for (const [a, c] of [
        [left, right],
        [right, left],
      ]) {
        const result = mergeNativeText(b(base), b(a), b(c), 'file.ts');
        assert.equal(result?.toString(), left);
      }
    }
  }
});

test('native import merge retains distinct imports, existing duplicates and scoped requires', () => {
  const base = "import { join } from 'node:path';\nexport const value = 1;\n",
    added = "import { readFileSync } from 'node:fs';\n",
    different = "import { writeFileSync } from 'node:fs';\n";
  assert.equal(
    mergeNativeText(b(base), b(added + base), b(base + different), 'file.ts')?.toString(),
    added + base + different,
  );
  const existing = added + base;
  assert.equal(
    mergeNativeText(b(existing), b(added + existing), b(existing + different), 'file.ts')?.toString(),
    added + existing + different,
  );
  const scoped = "function a() {\n  const fs = require('node:fs');\n}\n";
  assert.equal(
    mergeNativeText(b(base), b(scoped + base), b(base + scoped.replace('a()', 'c()')), 'file.js')?.toString(),
    scoped + base + scoped.replace('a()', 'c()'),
  );
  assert.equal(
    mergeNativeText(b(base), b(added + base), b(base + added), 'notes.txt')?.toString(),
    added + base + added,
  );
});

test('native import merge conflicts instead of deleting order-sensitive require additions', () => {
  const base = "const path = require('node:path');\nexports.value = 1;\n";
  for (const added of [
    "const fs = require('node:fs');\n",
    "require('node:fs');\n",
    "import fs = require('node:fs');\n",
    "import { readFileSync } from 'node:fs'; // keep this comment\n",
  ]) {
    assert.equal(mergeNativeText(b(base), b(added + base), b(base + added), 'file.ts'), null);
  }
});

test('native State composition uses import reconciliation and preserves ambiguous conflicts', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-imports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = initNative(root).head,
    source = new NativeSource(root),
    baseText =
      "import { join } from 'node:path';\nimport { tmpdir } from 'node:os';\nexport const value = 1;\n",
    state = (text, parent, message) =>
      source.writeState(
        [{ path: 'file.ts', mode: 'file', blob: source.put(b(text)) }],
        [parent],
        message,
        'now',
      ),
    base = state(baseText, origin, 'Base');
  for (const added of ["import { readFileSync } from 'node:fs';\n", "const fs = require('node:fs');\n"]) {
    const left = state(added + baseText, base, 'Left'),
      right = state(baseText.replace('export const', added + 'export const'), base, 'Right'),
      result = source.compose(left, right, 'Combine', 'now');
    if (added.startsWith('const')) assert.deepEqual(result.conflicts, ['file.ts']);
    else {
      assert.deepEqual(result.conflicts, []);
      assert.equal(source.object(source.state(result.head).files[0].blob).toString(), added + baseText);
    }
  }
});

test('native retained Views expose shared paths and compose non-overlapping text edits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-collab-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'one\ntwo\nthree\nfour\n');
  initNative(root);
  const w = new WorkService(root),
    s = new NativeSource(root);
  const act = c => w.execute(c, w.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Concurrent edits' }),
    a = act({ action: 'lane', intentId: intent.id, name: 'A' }),
    c = act({ action: 'lane', intentId: intent.id, name: 'B' });
  for (const [lane, content] of [
    [a, 'ONE\ntwo\nthree\nfour\n'],
    [c, 'one\ntwo\nthree\nFOUR\n'],
  ]) {
    writeFileSync(join(w.store.path(lane.id), 'file.txt'), content);
    const report = s.captureReport(w.store.path(lane.id), false, lane.head);
    act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: lane.head,
      expectedTree: s.tree(report.files),
      message: lane.name,
    });
  }
  const lane = id => w.store.load().lanes.find(x => x.id === id),
    compose = ids =>
      act({
        action: 'compose',
        operationId: randomUUID(),
        intentId: intent.id,
        inputs: ids.map(id => ({ laneId: id, head: lane(id).head })),
      });
  const av = compose([a.id]),
    bv = compose([c.id]),
    both = compose([a.id, c.id]);
  assert.equal(both.status, 'clean');
  assert.equal(
    s.object(s.state(both.head).files.find(f => f.path === 'file.txt').blob).toString(),
    'ONE\ntwo\nthree\nFOUR\n',
  );
  const compared = (
    await w.dispatch(
      {
        action: 'compare-views',
        viewId: av.id,
        expectedHead: av.head,
        otherViewId: bv.id,
        otherHead: bv.head,
        offset: 0,
        limit: 10,
      },
      w.store.load().revision,
    )
  ).result;
  assert.equal(compared.status, 'observed');
  assert.equal(compared.commonPathCount, 1);
  assert.equal(compared.sharedPaths[0].display, 'file.txt');
  assert.match(compared.provenance, /native State/);
  writeFileSync(join(w.store.path(a.id), '.env'), 'DO_NOT_COPY=private');
  mkdirSync(join(w.store.path(a.id), 'secret'));
  writeFileSync(join(w.store.path(a.id), 'secret', 'credentials.json'), 'private');
  writeFileSync(join(w.store.path(a.id), 'file.txt'), 'ONE\nTWO\nthree\nfour\n');
  const reviewed = w.status().lanes.find(x => x.id === a.id);
  assert.ok(reviewed.captureCoverage.excluded.some(x => x.path === '.env'));
  const checkpoint = act({
    action: 'checkpoint',
    laneId: a.id,
    expectedHead: lane(a.id).head,
    expectedTree: reviewed.indexTree,
    message: 'Coverage',
  });
  assert.ok(checkpoint.checkpoints.at(-1).captureCoverage.excludedCount > 0);
  assert.ok(!s.state(checkpoint.head).files.some(x => x.path === '.env'));
});

test('native composition keeps non-adjacent file/directory collisions explicit', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-path-overlap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initNative(root);
  const source = new NativeSource(root),
    store = new WorkService(root).store,
    base = store.load().nativeHead,
    blob = source.put(b('bytes'));
  const file = path => ({ path, blob, mode: 'file' });
  const left = source.writeState([file('a'), file('a-guard')], [base], 'Left', 'now'),
    right = source.writeState([file('a/child')], [base], 'Right', 'now');
  assert.deepEqual(source.compose(left, right, 'Combine', 'now').conflicts, ['a']);
  assert.throws(
    () => source.writeState([file('a'), file('a-guard'), file('a/child')], [base], 'Invalid', 'now'),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
});

test('native composition preserves executable modes and conservative add/delete/rename/binary outcomes', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-composition-matrix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initNative(root);
  const source = new NativeSource(root),
    origin = new WorkService(root).store.load().nativeHead;
  const entry = (path, text, mode = 'file') => ({ path, blob: source.put(b(text)), mode }),
    original = entry('a', 'one\ntwo\n'),
    base = source.writeState([original], [origin], 'Base', 'now');
  const pair = (left, right) =>
    source.compose(
      source.writeState(left, [base], 'Left', 'now'),
      source.writeState(right, [base], 'Right', 'now'),
      'Compose',
      'now',
    );
  let result = pair([{ ...original, mode: 'executable' }], [entry('a', 'one\nTWO\n')]);
  assert.equal(result.conflicts.length, 0);
  let merged = source.state(result.head).files[0];
  assert.equal(merged.mode, 'executable');
  assert.equal(source.object(merged.blob).toString(), 'one\nTWO\n');
  assert.deepEqual(pair([], [entry('a', 'edit')]).conflicts, ['a']);
  assert.equal(source.state(pair([], [original]).head).files.length, 0);
  assert.deepEqual(pair([{ ...original, path: 'renamed' }], [entry('a', 'edit')]).conflicts, ['a']);
  result = pair([original, entry('left', 'new')], [original, entry('right', 'new')]);
  assert.deepEqual(
    source.state(result.head).files.map(x => x.path),
    ['a', 'left', 'right'],
  );
  assert.deepEqual(pair([original, entry('new', 'left')], [original, entry('new', 'right')]).conflicts, [
    'new',
  ]);
  assert.deepEqual(pair([entry('a', 'one\0left')], [entry('a', 'one\0right')]).conflicts, ['a']);
});
