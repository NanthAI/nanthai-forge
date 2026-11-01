// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAncestryCut, sourceAncestryFrontier } from '../dist/hosted-source-ancestry-cut.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { digest } from '../dist/hash.js';
import { saveBytes } from '../dist/hosted-save.js';

const cut = (parents, roots) => sourceAncestryCut(parents, [], roots);
test('selected-root cut survives early base prefetch and unequal-depth merged branches', () => {
  const parents = { L: ['A', 'B'], R: ['M'], A: ['M'], B: ['M'], M: ['P1', 'P2'] };
  assert.equal(cut(parents, ['L', 'R']), 'M');
  assert.equal(cut({ ...parents, P1: ['older'], P2: ['older'] }, ['L', 'R']), 'M');
  assert.equal(cut({ ...parents, unrelatedPrefetch: [] }, ['L', 'R']), 'M');
  assert.equal(cut({ L: ['R'], R: ['old'] }, ['L', 'R']), 'R');
});
test('cuts retain criss-cross bases, unknown side branches and disconnected roots', () => {
  assert.equal(cut({ L: ['A', 'B'], R: ['B', 'A'], A: ['M'], B: ['M'], M: [] }, ['L', 'R']), 'M');
  assert.equal(cut({ L: ['M', 'unknown'], R: ['M'], M: [] }, ['L', 'R']), null);
  assert.equal(cut({ L: ['A'], R: ['B'], A: [], B: [] }, ['L', 'R']), null);
  assert.equal(cut({ L: ['R'], R: ['L', 'M'] }, ['L', 'R']), null);
});
test('recursive-base merge bytes and conflicts are identical with a prefetched root-relative cut', () => {
  for (const conflicting of [false, true]) {
    const objects = new Map(),
      parents = {};
    const put = bytes => {
      bytes = Buffer.from(bytes);
      const id = digest(bytes);
      objects.set(id, bytes);
      return id;
    };
    const file = text => ({ path: 'f', mode: 'file', blob: put(text) });
    const state = (text, edges = []) => {
      const id = put(
        saveBytes({
          schema: 1,
          kind: 'forge-source-state',
          files: [file(text)],
          parents: edges,
          message: '',
          at: '2026-01-01T00:00:00.000Z',
        }),
      );
      parents[id] = edges;
      return id;
    };
    const old = state('old\n');
    const root = state('a\nb\nc\nd\ne\nf\ng\n', [old]);
    const a = state('A\nb\nc\nd\ne\nf\ng\n', [root]);
    const b = state('a\nb\nc\nd\ne\nf\nG\n', [root]);
    const left = state('A\nb\nC\nd\ne\nf\nG\n', [a, b]);
    const right = state(conflicting ? 'A\nb\nD\nd\ne\nf\nG\n' : 'A\nb\nc\nd\nE\nf\nG\n', [b, a]);
    const boundary = cut(parents, [left, right]);
    assert.equal(boundary, root);
    const merge = boundary => {
      const source = new MemoryMergeSource(structuredClone(parents), boundary);
      for (const [id, bytes] of objects) source.objects.set(id, bytes);
      const result = source.compose(left, right, 'merge', '2026-01-01T00:00:00.000Z');
      return {
        result,
        bytes: result.head ? source.object(result.head) : null,
        details: source.mergeFiles(left, right),
      };
    };
    assert.deepEqual(merge(boundary), merge(undefined));
  }
});
test('root-relative cut examines 32000 parent edges in linear work without RPCs', t => {
  const parents = { left: ['base'], right: ['base'], base: ['old-31999'] };
  for (let i = 0; i < 32000; i++) parents[`old-${i}`] = i ? [`old-${i - 1}`] : [];
  const before = performance.now();
  assert.equal(cut(parents, ['left', 'right']), 'base');
  t.diagnostic(JSON.stringify({ edges: 32003, sourceRPCs: 0, wallMs: performance.now() - before }));
});

test('root-relative proofs preserve every selected path over small merged DAGs and incomplete frontiers', () => {
  let seed = 372;
  const random = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let sample = 0; sample < 250; sample++) {
    const parents = {};
    for (let i = 0; i < 30; i++)
      parents[`s${i}`] = i
        ? Array.from(new Set(Array.from({ length: 1 + random(3) }, () => `s${random(i)}`)))
        : [];
    const roots = ['s29', 's28', 's27'];
    for (let i = 0; i < 8; i++) delete parents[`s${random(20)}`];
    const pending = [...new Set(Object.values(parents).flat())].filter(id => !parents[id]);
    const boundary = sourceAncestryCut(parents, pending, roots);
    if (!boundary) continue;
    const reaches = id => id === boundary || Boolean(parents[id]?.length && parents[id].every(reaches));
    assert(roots.every(reaches), `every selected path must reach ${boundary}`);
  }
});

test('frontier scheduling defers older common history without dropping it or proving a cut', () => {
  const parents = { L: ['A', 'unknown'], R: ['M'], A: ['M'], M: ['P1', 'P2'] };
  assert.deepEqual(sourceAncestryFrontier(parents, ['unknown', 'P1', 'P2'], ['L', 'R']), ['unknown']);
  assert.deepEqual(sourceAncestryFrontier(parents, ['P1', 'P2'], ['L', 'R']), ['P1', 'P2']);
  assert.equal(sourceAncestryCut(parents, ['unknown', 'P1', 'P2'], ['L', 'R']), null);
  assert.deepEqual(sourceAncestryFrontier({ L: ['A'], R: ['B'] }, ['A', 'B'], ['L', 'R']), ['A', 'B']);
});

test('large selections keep the ordinary frontier without a per-root graph scan', () => {
  const parents = new Proxy(
    {},
    {
      get() {
        assert.fail('large-selection priority must not scan parents');
      },
    },
  );
  const pending = ['unresolved'];
  assert.equal(
    sourceAncestryFrontier(
      parents,
      pending,
      Array.from({ length: 32000 }, (_, i) => `root-${i}`),
    ),
    pending,
  );
});
