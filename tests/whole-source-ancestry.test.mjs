// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestryFixture, at } from './source-ancestry-fixture.mjs';

test('ten whole-worker compositions keep exact output and stay within stepped manifest reads', async () => {
  const s = ancestryFixture();
  let a = s.state([], [], 'old-a'),
    b = s.state([], [], 'old-b');
  const deepHistory = new Set([a, b]);
  for (let i = 0; i < 32; i++) {
    a = s.state([], [a]);
    b = s.state([], [b]);
    if (i < 22) deepHistory.add(a).add(b);
  }
  const base = s.state([], [a, b]);
  let main = s.state([], [base], 'main');
  for (let i = 0; i < 10; i++) {
    const lane = s.state([s.file(`member-${i}`, `change ${i}\n`)], [base]);
    const initial = s.plan(main, [lane]);
    const manifestReads = start => s.reads.slice(start).filter(id => Object.hasOwn(s.parents, id));
    const start = s.reads.length;
    const stepped = await s.compose(initial);
    const steppedReads = manifestReads(start);
    const wholeStart = s.reads.length;
    const whole = await s.whole(initial);
    const selected = manifestReads(wholeStart);
    assert.deepEqual(whole.output, stepped.output);
    assert.deepEqual(whole.headBytes, stepped.headBytes);
    assert(
      selected.length <= steppedReads.length,
      `member ${i}: ${selected.length} > ${steppedReads.length}`,
    );
    assert(!selected.some(id => deepHistory.has(id)), 'the deeper retained history stays unread');
    s.parents[whole.head] = JSON.parse(whole.headBytes).parents;
    main = whole.head;
  }
});

for (const shape of ['criss-cross', 'restore']) {
  test(`whole-worker ${shape} merge preserves exact base trees and output bytes`, async () => {
    const s = ancestryFixture(),
      file = text => s.file('f.txt', text),
      past = s.state([file('older\n')]),
      base = s.state([file('a\nb\nc\nd\ne\nf\ng\n')], [past]),
      a = s.state([file('A\nb\nc\nd\ne\nf\ng\n')], [base]),
      b = s.state([file('a\nb\nc\nd\ne\nf\nG\n')], [base]),
      left = s.state([file('A\nb\nC\nd\ne\nf\nG\n')], [a, b]),
      right = s.state([file('A\nb\nc\nd\nE\nf\nG\n')], [b, a]);
    // The restore has an explicit base that is not reachable from either tip.
    const restoreBase =
      shape === 'restore' ? s.state([file('A\nb\nc\nd\ne\nf\nG\n')], [past], 'pinned') : undefined;
    const initial = s.plan(left, [right], restoreBase);
    const oracle = await s.compose(initial, { complete: true });
    const start = s.reads.length;
    const whole = await s.whole(initial);
    const reads = s.reads.slice(start);
    assert.deepEqual(whole.output, oracle.output);
    assert.deepEqual(whole.headBytes, oracle.headBytes);
    assert.equal(JSON.parse(whole.output).result.status, 'clean');
    assert.equal(
      s.objects.get(JSON.parse(whole.headBytes).files[0].blob).toString(),
      'A\nb\nC\nd\nE\nf\nG\n',
    );
    assert(!reads.includes(past), 'recursive or explicit base handling does not read older history');
    for (const id of restoreBase ? [restoreBase] : [a, b, base]) assert(reads.includes(id));
    if (restoreBase) for (const id of [a, b, base]) assert(!reads.includes(id));
  });
}

test('long divergent sync walks the late cut, verifies its base on retry and keeps exact conflict pins', async () => {
  const s = ancestryFixture();
  const file = text => s.file('conflict.txt', text);
  const older = s.state([file('old\n')]);
  const baseFile = file('base\n');
  const base = s.state([baseFile], [older]);
  const leftFile = file('lane\n'),
    rightFile = file('main\n');
  let left = base,
    right = base;
  for (let i = 0; i < 130; i++) {
    left = s.state([leftFile], [left]);
    right = s.state([rightFile], [right]);
  }
  const input = s.json({
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: { mode: 'sync', left: s.ref(left), right: s.ref(right) },
    message: 'sync',
    at,
  });
  const baseBytes = s.objects.get(base);
  const before = s.objects.size;
  s.objects.set(base, Buffer.from(baseBytes).fill(0, 0, 1));
  await assert.rejects(s.whole({ input }), { code: 'SOURCE_HASH_MISMATCH' });
  assert.equal(s.objects.size, before, 'an invalid required base publishes no partial output');
  s.objects.set(base, baseBytes);
  const start = s.reads.length;
  const whole = await s.whole({ input });
  const { result } = JSON.parse(whole.output);
  assert.equal(result.status, 'conflict');
  const page = JSON.parse(s.objects.get(result.conflicts.sha256));
  assert.equal(page.left, left);
  assert.equal(page.right, right);
  assert.deepEqual(page.paths, [{ path: baseFile.path, base: baseFile, left: leftFile, right: rightFile }]);
  assert.deepEqual(JSON.parse(whole.headBytes).parents, [left]);
  assert(!s.reads.slice(start).includes(older));
  assert.equal(new Set(s.reads.slice(start)).size, s.reads.length - start);
});
