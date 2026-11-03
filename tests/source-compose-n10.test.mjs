// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAncestryCut, sourceAncestryFrontier } from '../dist/hosted-source-ancestry-cut.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { parseNativeState } from '../dist/native-state-format.js';
import { digest } from '../dist/hash.js';
import { saveBytes } from '../dist/hosted-save.js';
import { ancestryFixture } from './source-ancestry-fixture.mjs';

// Retained pre-fix reducer, to measure the same source/merge work on both sides.
function oldCut(parents, pending) {
  const frontier = [...new Set(pending)].filter(id => !parents[id]);
  const nodes = Object.keys(parents);
  if (frontier.length !== 1 || !nodes.length) return null;
  const boundary = frontier[0],
    remaining = new Map(),
    children = new Map();
  for (const id of nodes) {
    remaining.set(id, parents[id].length);
    for (const parent of parents[id]) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const reached = new Set([boundary]),
    queue = [boundary];
  for (let i = 0; i < queue.length; i++)
    for (const child of children.get(queue[i]) ?? []) {
      remaining.set(child, remaining.get(child) - 1);
      if (remaining.get(child) === 0 && !reached.has(child)) {
        reached.add(child);
        queue.push(child);
      }
    }
  return nodes.every(id => reached.has(id)) ? boundary : null;
}
test('N=10 composition: verified root-relative cut avoids growing ancestry and preserves exact results', t => {
  const objects = new Map(),
    allParents = {};
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const file = (path, text) => ({ path, mode: 'file', blob: put(text) });
  const files = Array.from({ length: 28000 }, (_, i) =>
    file(
      `synthetic/apps/server/src/preview/components/queued/source/${String(i).padStart(8, '0')}.ts`,
      'shared\n',
    ),
  );
  const state = (files, parents = []) => {
    const id = put(
      saveBytes({
        schema: 1,
        kind: 'forge-source-state',
        files,
        parents,
        message: 'fixture',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
    allParents[id] = parents;
    return id;
  };
  // Two retained parent histories keep the old unknown frontier plural, the
  // RCA's M -> P1,P2 shape. A single old chain can still satisfy the old cut.
  let olderA = state(files),
    olderB = state([...files, file('historical-only', 'old')]);
  for (let i = 0; i < 20; i++) {
    olderA = state(files, [olderA]);
    olderB = state([...files, file('historical-only', 'old')], [olderB]);
  }
  const base = state(files, [olderA, olderB]);
  const branches = Array.from({ length: 10 }, (_, i) =>
    state([...files, file(`member-${i}`, `change ${i}`)], [base]),
  );
  let main = base;
  const pairs = [];
  for (let i = 0; i < 10; i++) {
    // A previous acceptance is a two-parent merge, just as in the incident.
    main = state(
      [...files, ...Array.from({ length: i }, (_, k) => file(`member-${k}`, `change ${k}`))],
      i ? [main, branches[i - 1]] : [base],
    );
    pairs.push([main, branches[i]]);
  }
  const run = (reducer, prioritize = (_parents, pending) => pending) => {
    const start = performance.now();
    let reads = 0,
      bytes = 0;
    const results = [];
    for (const roots of pairs) {
      const parents = {},
        loaded = new Map();
      let pending = roots,
        boundary = null;
      while (pending.length) {
        for (const id of prioritize(
          parents,
          [...new Set(pending)].filter(id => !parents[id]),
          roots,
        )) {
          const raw = objects.get(id);
          assert.equal(digest(raw), id, 'both measurements verify every manifest');
          const manifest = parseNativeState(raw);
          parents[id] = manifest.parents;
          loaded.set(id, raw);
          reads++;
          bytes += raw.length;
        }
        pending = [...new Set(Object.values(parents).flat())].filter(id => !parents[id]);
        boundary = reducer(parents, pending, roots);
        if (boundary) break;
      }
      // Merge uses the actual unchanged native recursive-base implementation.
      const source = new MemoryMergeSource(parents, boundary ?? undefined);
      for (const [id, raw] of objects) source.objects.set(id, raw);
      const result = source.compose(...roots, 'merge', '2026-01-01T00:00:00.000Z');
      results.push({ result, bytes: source.object(result.head) });
    }
    return { wallMs: performance.now() - start, manifestReads: reads, manifestBytes: bytes, results };
  };
  const before = run(oldCut),
    after = run(sourceAncestryCut, sourceAncestryFrontier);
  assert.deepEqual(after.results, before.results);
  assert(after.manifestReads < before.manifestReads / 2);
  assert(after.manifestBytes < before.manifestBytes / 2);
  const summary = ({ results, ...metrics }) => metrics;
  t.diagnostic(
    JSON.stringify({
      queued: 10,
      filesPerState: 28000,
      manifestBytes: objects.get(base).length,
      before: summary(before),
      after: summary(after),
      rpcCalls: 0,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('N=10 asymmetric descendants from different main versions match complete verified ancestry', async t => {
  const reports = [];
  for (const depth of [0, 10, 400, 800])
    for (const reverse of [false, true]) {
      const s = ancestryFixture(),
        historical = new Set();
      let old;
      for (let i = 0; i < depth; i++) {
        old = s.state([], old ? [old] : [], `old-${i}`);
        historical.add(old);
      }
      const base = s.state([s.file('root', 'base\n')], old ? [old] : [], 'C');
      const files = i => [
        s.file('root', 'base\n'),
        ...Array.from({ length: i }, (_, j) => s.file(`member-${j}`, `change ${j}\n`)),
      ];
      const a = s.state(files(1), [base], 'A'),
        b = s.state([s.file('root', 'base\n'), s.file('other', 'other\n')], [base], 'B');
      const main = s.state([...files(1), s.file('other', 'other\n')], reverse ? [b, a] : [a, b], 'M');
      // Normal Lanes may start from any accepted main, including descendants
      // of one parent of the two-parent main selected for this composition.
      const branches = Array.from({ length: 10 }, (_, i) =>
        s.state([...files(1), s.file(`lane-${i}`, `lane ${i}\n`)], [a], `D${i}`),
      );
      const initial = s.plan(main, reverse ? branches.toReversed() : branches),
        oracle = await s.compose(initial, { complete: true }),
        selected = await s.compose(initial);
      assert.deepEqual(selected.output, oracle.output);
      assert.deepEqual(selected.headBytes, oracle.headBytes);
      assert.equal(selected.cursor.ancestryBoundary, base);
      const manifestReads = selected.graphReads.filter(id => s.parents[id]).length;
      assert.equal(manifestReads, 13, `depth=${depth}`);
      assert(!selected.graphReads.some(id => historical.has(id) || id === base));
      reports.push({ depth, reverse, manifestReads, olderReads: 0 });
    }
  t.diagnostic(JSON.stringify({ reports }));
});

test('persisted Q/A-chain composition remains history-independent across cursor and parent orders', async t => {
  const reports = [];
  for (const depth of [0, 10, 400, 800])
    for (const reverse of [false, true])
      for (const preloaded of [false, true]) {
        const s = ancestryFixture(),
          historical = new Set();
        let old;
        for (let i = 0; i < depth; i++) {
          old = s.state([], old ? [old] : [], `old-${i}`);
          historical.add(old);
        }
        const c = s.state([s.file('f', 'base\n')], old ? [old] : [], 'C'),
          a = s.state([s.file('f', 'A\n')], [c], 'A'),
          q = s.state([s.file('f', 'Q\n')], [a], 'Q'),
          b = s.state([s.file('f', 'B\n')], [c], 'B'),
          m = s.state([s.file('f', 'main\n')], reverse ? [b, q] : [q, b], 'M'),
          d = s.state([s.file('f', 'lane\n')], [q], 'D'),
          initial = s.plan(reverse ? d : m, [reverse ? m : d]);
        if (preloaded) {
          initial.parents[q] = [a];
          initial.phase = 'graph';
          initial.head = initial.plan.base.head;
          initial.selections = JSON.parse(s.objects.get(initial.plan.inputs.root.sha256)).entries;
          initial.inventory[m] = s.ref(m);
          initial.inventory[d] = s.ref(d);
          initial.states = [m, d, a];
        }
        const oracle = await s.compose(initial, { complete: true }),
          selected = await s.compose(initial);
        assert.deepEqual(selected.output, oracle.output);
        assert.deepEqual(selected.headBytes, oracle.headBytes);
        assert.equal(selected.cursor.ancestryBoundary, c);
        assert(!selected.graphReads.some(id => historical.has(id)));
        const manifestReads = selected.graphReads.filter(id => s.parents[id]).length;
        assert.equal(manifestReads, preloaded ? 5 : 6);
        reports.push({ depth, reverse, preloaded, manifestReads });
      }
  t.diagnostic(JSON.stringify({ reports, historicalReads: 0 }));
});

for (const kind of ['clean', 'conflict', 'criss-cross', 'closed-roots', 'restore-base'])
  test(`persisted ${kind} composition matches the complete ancestry oracle with absent/empty/incomplete/misordered hints`, async () => {
    const s = ancestryFixture(),
      common = s.state([s.file('f', 'a\nb\nc\nd\ne\nf\ng\n')], [], 'common'),
      a = s.state([s.file('f', 'A\nb\nc\nd\ne\nf\ng\n')], [common], 'a'),
      b = s.state([s.file('f', 'a\nb\nc\nd\ne\nf\nG\n')], [common], 'b');
    const left = s.state(
      [s.file('f', 'A\nb\nC\nd\ne\nf\nG\n')],
      kind === 'closed-roots' ? [] : [a, b],
      'left',
    );
    const right = s.state(
      [s.file('f', kind === 'clean' ? 'A\nb\nc\nd\nE\nf\nG\n' : 'A\nb\nD\nd\ne\nf\nG\n')],
      kind === 'closed-roots' ? [] : kind === 'criss-cross' ? [b, a] : [a],
      'right',
    );
    const initial = s.plan(left, [right], kind === 'restore-base' ? common : undefined);
    // Verified unrelated prefetch forces the paged-hint seam without changing
    // the selected roots. Hints themselves remain untrusted and incomplete.
    for (let i = 0; i < 32; i++) initial.parents[s.state([], [], `prefetch-${i}`)] = [];
    if (kind === 'closed-roots') {
      await assert.rejects(s.compose(initial, { complete: true }), { code: 'NATIVE_MERGE_BASE_UNKNOWN' });
      for (const hintMode of ['absent', 'empty', 'incomplete', 'misordered'])
        await assert.rejects(s.compose(initial, { hintMode }), { code: 'NATIVE_MERGE_BASE_UNKNOWN' });
      return;
    }
    const oracle = await s.compose(initial, { complete: true });
    for (const hintMode of ['absent', 'empty', 'incomplete', 'misordered']) {
      const before = s.hints.length;
      const selected = await s.compose(initial, { hintMode });
      assert.deepEqual(selected.output, oracle.output, hintMode);
      assert.deepEqual(selected.headBytes, oracle.headBytes, hintMode);
      assert.deepEqual(JSON.parse(selected.output).result.status, kind === 'clean' ? 'clean' : 'conflict');
      assert.equal(
        s.hints.length > before,
        hintMode !== 'absent',
        'exercise the actual probe/cache hint seam',
      );
    }
  });
