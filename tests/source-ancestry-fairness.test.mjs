// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAncestryCut, sourceAncestryFrontier } from '../dist/hosted-source-ancestry-cut.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { applySourceFanout } from '../dist/hosted-source-fanout.js';
import { ancestryFixture } from './source-ancestry-fixture.mjs';

test('fixed-seed DAG walks prove breadth-first fairness, every-path cuts and oracle-equal merge bytes', t => {
  const initialSeed = 91364827;
  let seed = initialSeed,
    walks = 0,
    cuts = 0;
  const random = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let sample = 0; sample < 600; sample++) {
    const s = ancestryFixture(),
      nodes = [];
    for (let i = 0; i < 25; i++) {
      const edges = i ? Array.from({ length: 1 + random(3) }, () => nodes[random(i)]) : [];
      const files = random(5) ? [s.file('f', `variant ${random(5)}\n`)] : [];
      nodes.push(s.state(files, edges, `node ${i}`));
    }
    const roots = [...new Set([nodes[24], nodes[23], ...(sample % 3 ? [] : [nodes[21]])])];
    if (sample % 2) roots.reverse();
    const distances = new Map(roots.map(id => [id, 0])),
      queue = [...roots];
    for (let i = 0; i < queue.length; i++)
      for (const parent of s.parents[queue[i]])
        if (!distances.has(parent)) {
          distances.set(parent, distances.get(queue[i]) + 1);
          queue.push(parent);
        }
    const merge = (parents, boundary) => {
      const source = new MemoryMergeSource(structuredClone(parents), boundary);
      for (const [id, bytes] of s.objects) source.objects.set(id, bytes);
      const result = source.compose(roots[0], roots[1], 'merge', '2026-01-01T00:00:00.000Z');
      return {
        result,
        bytes: result.head ? source.object(result.head) : null,
        details: source.mergeFiles(roots[0], roots[1]),
      };
    };
    const oracle = merge(s.parents);
    for (const width of [1, 3, 100]) {
      const loaded = {};
      // Arbitrarily prefetched verified metadata must not select new roots or
      // let a hidden nearer path lose priority. Include duplicate parent edges.
      for (const id of nodes) if (random(5) === 0) loaded[id] = s.parents[id];
      let pending = [...new Set([...roots, ...Object.values(loaded).flat()])].filter(id => !loaded[id]);
      let boundary = null,
        rounds = 0;
      while (pending.length && !(boundary = sourceAncestryCut(loaded, pending, roots))) {
        assert(++rounds <= nodes.length);
        if (sample % 2) pending.reverse();
        const selected = sourceAncestryFrontier(loaded, pending, roots).slice(0, width),
          minimum = Math.min(...pending.map(id => distances.get(id) ?? Infinity));
        assert(selected.length);
        // Zero depth slack: a pending node at d is attempted before any
        // readable node deeper than d, even when a layer exceeds the window.
        for (const id of selected)
          assert.equal(distances.get(id) ?? Infinity, minimum, `sample=${sample}, width=${width}`);
        for (const id of selected) loaded[id] = s.parents[id];
        pending = [...new Set([...pending, ...selected.flatMap(id => s.parents[id])])].filter(
          id => !loaded[id],
        );
      }
      boundary ??= sourceAncestryCut(loaded, pending, roots);
      if (boundary) {
        const memo = new Map();
        const reaches = id => {
          if (id === boundary) return true;
          if (memo.has(id)) return memo.get(id);
          const result = Boolean(loaded[id]?.length && loaded[id].every(reaches));
          memo.set(id, result);
          return result;
        };
        assert(roots.every(reaches), `cut=${boundary}, sample=${sample}`);
        cuts++;
      }
      assert.deepEqual(merge(loaded, boundary ?? undefined), oracle, `sample=${sample}, width=${width}`);
      walks++;
    }
  }
  t.diagnostic(JSON.stringify({ seed: initialSeed, graphs: 600, walks, cuts, windowDepthSlack: 0 }));
});

// Parent fan-out continuations must keep stable pending ties, including a
// failed probe: reversing this list can starve the tail of a wide frontier.
test('fan-out graph joins preserve pending order and append verified parents after it', () => {
  const c = {
    phase: 'graph',
    states: ['early', 'A', 'blocked', 'B', 'late'],
    parents: {},
    seen: {},
    inventory: {},
  };
  applySourceFanout(
    c,
    { kind: 'states', end: 0 },
    [
      {
        states: [
          { id: 'A', parents: ['child-A'], files: [], error: null },
          { id: 'B', parents: ['child-B'], files: [], error: null },
          { id: 'blocked', parents: [], files: [], error: 'SOURCE_UNAVAILABLE' },
        ],
      },
    ],
    () => assert.fail(),
  );
  assert.deepEqual(c.states, ['early', 'blocked', 'late', 'child-A', 'child-B']);
  assert.deepEqual(c.ancestryFailures, { blocked: 'SOURCE_UNAVAILABLE' });
  assert.equal(c.parents.blocked, undefined, 'a failed probe never supplies an empty parent list');
});

test('a full 100-object window cannot advance past remaining shallow ties', () => {
  const near = Array.from({ length: 128 }, (_, i) => `near-${i}`),
    parents = { root: near };
  const first = sourceAncestryFrontier(parents, near, ['root']).slice(0, 100);
  assert.deepEqual(first, near.slice(0, 100));
  for (const id of first) parents[id] = ['deeper'];
  const pending = [...near.slice(100), 'deeper'];
  assert.deepEqual(sourceAncestryFrontier(parents, pending, ['root']), near.slice(100));
});
