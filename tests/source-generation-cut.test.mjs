// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceGenerationWalk } from '../dist/hosted-source-generation-cut.js';
import { sourceAncestryFrontier } from '../dist/hosted-source-ancestry-cut.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { ancestryFixture } from './source-ancestry-fixture.mjs';

import { generationGraph, generationFailureGraph } from './source-generation-fixture.mjs';
import { runSourceStep } from '../dist/hosted-source-step.js';

function walk(s, roots, window = 100) {
  const parents = {},
    remaining = new Set(roots),
    reads = [];
  let cuts;
  for (let round = 0; remaining.size; round++) {
    assert(round < 2000);
    const proof = sourceGenerationWalk(parents, s.generations, roots);
    if (proof?.cuts) {
      cuts = proof.cuts;
      break;
    }
    const frontier = proof?.frontier.length
      ? proof.frontier
      : sourceAncestryFrontier(parents, [...remaining], roots);
    frontier.splice(window);
    for (const id of frontier) {
      parents[id] = s.parents[id];
      remaining.delete(id);
      reads.push(id);
    }
    for (const id of frontier) for (const parent of parents[id]) if (!parents[parent]) remaining.add(parent);
  }
  return { parents, cuts, reads };
}
function merge(s, left, right, parents, cuts) {
  const source = new MemoryMergeSource(structuredClone(parents), undefined, cuts);
  for (const [id, bytes] of s.objects) source.objects.set(id, bytes);
  const result = source.compose(left, right, 'merge', '2026-01-01T00:00:00.000Z');
  return {
    result,
    bytes: result.head ? source.object(result.head) : null,
    details: source.mergeFiles(left, right),
  };
}

for (const privateBranch of [false, true])
  test(`generation frontier retains required ${privateBranch ? 'private-proof' : 'common-base'} failures and settles the original error`, async () => {
    const { s, failed, q, initial } = generationFailureGraph({ privateBranch }),
      reads = new Map();
    // Keep the exact descriptor/level and corrupt only the required body.
    s.objects.set(failed, Buffer.alloc(s.ref(failed).object.size, 120));
    let cursor = initial,
      quanta = 0;
    await assert.rejects(
      async () => {
        while (cursor.phase !== 'done') {
          assert(++quanta <= 6, 'failed generation priority must not consume endless quanta');
          cursor = (
            await runSourceStep(cursor, {
              stateGeneration: id => s.generations[id],
              describeBatch: async ids => ids.map(s.ref),
              read: async pin => {
                reads.set(pin.sha256, (reads.get(pin.sha256) ?? 0) + 1);
                if (pin.sha256 === failed)
                  assert.equal(reads.get(failed), 1, 'retained failure is never refetched');
                return (async function* () {
                  yield s.objects.get(pin.sha256);
                })();
              },
              upload: async () => assert.fail('required error cannot publish output'),
            })
          ).cursor;
        }
      },
      error => error.code === 'SOURCE_HASH_MISMATCH',
    );
    assert.equal(reads.get(q), 1, 'lower-generation readable fallback advances');
    assert.equal(reads.get(failed), 1);
  });

test('only an independent authenticated generation cut retires a retained failed probe', async () => {
  const { s, initial } = generationGraph('closed-side', 10),
    oracle = await s.compose(initial, { complete: true }),
    closedSide = Object.keys(s.parents).find(id => JSON.parse(s.objects.get(id)).message === 'U');
  initial.ancestryFailures = { [closedSide]: 'SOURCE_HASH_MISMATCH' };
  initial.generations = { [closedSide]: s.generations[closedSide] };
  s.objects.set(closedSide, Buffer.alloc(s.ref(closedSide).object.size, 120));
  const actual = await s.compose(initial);
  assert.deepEqual(actual.output, oracle.output);
  assert.deepEqual(actual.headBytes, oracle.headBytes);
  assert(actual.cursor.ancestryCuts.includes(closedSide));
  assert(!actual.cursor.parents[closedSide], 'failure is never installed as a closed edge');
  assert.equal(actual.cursor.ancestryFailures[closedSide], 'SOURCE_HASH_MISMATCH');
  assert(!actual.graphReads.includes(closedSide));
});
for (const kind of ['closed-side', 'wide-closed-history'])
  test(`${kind}: helper and persisted reads stay constant at 0/10/400/800`, async t => {
    let expected;
    for (const count of [0, 10, 400, 800])
      for (const conflicting of [false, true]) {
        const { s, left, right, historical, initial } = generationGraph(kind, count, conflicting),
          result = walk(s, [left, right]);
        assert.deepEqual(
          merge(s, left, right, result.parents, result.cuts),
          merge(s, left, right, s.parents),
        );
        assert(result.cuts?.length);
        assert(!result.reads.some(id => historical.includes(id)));
        const oracle = await s.compose(initial, { complete: true }),
          selected = await s.compose(initial);
        assert.deepEqual(selected.output, oracle.output);
        assert.deepEqual(selected.headBytes, oracle.headBytes);
        assert(!selected.graphReads.some(id => historical.includes(id)));
        expected ??= selected.graphReads.length;
        assert.equal(selected.graphReads.length, expected);
        assert(selected.graphReads.length < 20);
        t.diagnostic(
          JSON.stringify({
            kind,
            count,
            conflicting,
            helperReads: result.reads.length,
            persistedReads: selected.graphReads.length,
          }),
        );
      }
  });
test('generation traversal fixed-seed DAG oracle, multiple bases and mixed metadata', async t => {
  let walks = 0,
    cuts = 0;
  let seed = 4903181;
  const random = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let sample = 0; sample < 600; sample++) {
    const s = ancestryFixture({ generationMetadata: true }),
      ids = [];
    for (let i = 0; i < 6 + random(14); i++) {
      const edges = ids.filter(() => random(4) === 0);
      if (i && !edges.length) edges.push(ids[0]);
      ids.push(s.state([s.file('f', `v${random(5)}\n`)], edges, `s${sample}:${i}`));
    }
    const left = ids.at(-1),
      right = ids.at(-2),
      result = walk(s, [left, right]);
    // Native compose may correctly report no common base; compare exact outcomes.
    const outcome = (parents, cuts) => {
      try {
        return merge(s, left, right, parents, cuts);
      } catch (error) {
        return { code: error.code };
      }
    };
    assert.deepEqual(outcome(result.parents, result.cuts), outcome(s.parents), `sample ${sample}`);
    for (const width of [1, 3, 100]) {
      const roots = sample % 3 ? [left, right] : [left, right, ids.at(-3), ids.at(-4)];
      const candidate = walk(s, roots, width);
      assert.deepEqual(
        outcome(candidate.parents, candidate.cuts),
        outcome(s.parents),
        `sample ${sample}, roots ${roots.length}, width ${width}`,
      );
      walks++;
      if (candidate.cuts) cuts++;
    }
    if (sample % 20 === 0) {
      delete s.generations[ids[random(ids.length)]];
      const plan = s.plan(left, [right]),
        oracle = await s.compose(plan, { complete: true });
      const actual = await s.compose(plan);
      assert.deepEqual(actual.output, oracle.output);
    }
  }
  assert(cuts > 0);
  t.diagnostic(JSON.stringify({ seed: 4903181, graphs: 600, walks, cuts }));
});
test('prefetched cycles below a candidate and unequal-generation criss-cross bases never prune', () => {
  const p = { L: ['Q', 'B'], R: ['Q', 'U'], Q: ['P'], B: ['P'], P: ['C'], C: ['P'], U: [] };
  assert.equal(sourceGenerationWalk(p, { L: 9, R: 9, Q: 8, B: 7, P: 6, C: 5, U: 1 }, ['L', 'R']), null);
  const s = ancestryFixture({ generationMetadata: true }),
    base = s.state([s.file('f', 'base\n')], [], 'base');
  let high = base;
  for (let i = 0; i < 10; i++) high = s.state([s.file('f', `high${i}\n`)], [high], `h${i}`);
  const low = s.state([s.file('f', 'low\n')], [base], 'low'),
    left = s.state([s.file('f', 'left\n')], [high, low], 'left'),
    right = s.state([s.file('f', 'right\n')], [low, high], 'right');
  for (const window of [1, 3, 100])
    for (const roots of [
      [left, right],
      [right, left],
    ]) {
      const result = walk(s, roots, window);
      assert.equal(result.cuts, undefined, 'all recursive merge-base ancestry stays on BFS');
      assert.deepEqual(merge(s, left, right, result.parents, result.cuts), merge(s, left, right, s.parents));
    }
});
test('restore bases and three-root plans retain complete-oracle bytes with generation metadata', async () => {
  const { s, left, right } = generationGraph('closed-side', 20);
  const restore = Object.keys(s.parents).find(id => s.parents[id].length === 0),
    plan = s.plan(left, [right], restore);
  const oracle = await s.compose(plan, { complete: true }),
    actual = await s.compose(plan);
  assert.deepEqual(actual.output, oracle.output);
  assert.deepEqual(actual.headBytes, oracle.headBytes);
  assert.equal(actual.cursor.ancestryCuts, undefined);
});
test('unknown roots, invalid/cyclic levels and three-root plans preserve BFS', () => {
  assert.equal(sourceGenerationWalk({ L: ['R'], R: ['L'] }, { L: 2, R: 1 }, ['L', 'R']), null);
  assert.deepEqual(sourceGenerationWalk({}, {}, ['L', 'R', 'Q']), {
    frontier: ['L', 'R', 'Q'],
    metadata: true,
  });
  assert.deepEqual(sourceGenerationWalk({}, { L: 1 }, ['L', 'unknown']), {
    frontier: ['unknown'],
    metadata: true,
  });
});

test('many selected tips prune one shared maximal base without pairwise RPCs', async () => {
  for (const count of [0, 10, 400, 800]) {
    const { s, left, right, historical } = generationGraph('closed-side', count),
      shared = s.parents[right][0];
    const heads = [
      right,
      ...Array.from({ length: 8 }, (_, i) => s.state([s.file(`tip${i}`, `${i}\n`)], [shared], `tip${i}`)),
    ];
    const roots = [left, ...heads],
      result = walk(s, roots, 3);
    assert(result.cuts);
    assert(result.reads.length < 20);
    assert(!result.reads.some(id => historical.includes(id)));
    const plan = s.plan(left, heads),
      oracle = await s.compose(plan, { complete: true }),
      actual = await s.compose(plan);
    assert.deepEqual(actual.output, oracle.output);
    assert.deepEqual(actual.headBytes, oracle.headBytes);
    assert(actual.graphReads.length < 30);
    assert(!actual.graphReads.some(id => historical.includes(id)));
  }
});
test('old in-flight cursors with verified parents but no level map resume on BFS', async () => {
  const { s, initial } = generationGraph('closed-side', 10);
  const { prepareMergeStep } = await import('../dist/hosted-source-step-merge.js');
  const { meter } = await import('../dist/hosted-source-step-verify.js');
  const cursor = structuredClone(initial),
    io = {
      describeBatch: async ids => ids.map(s.ref),
      stateGeneration: id => s.generations[id],
      read: async pin =>
        (async function* () {
          yield s.objects.get(pin.sha256);
        })(),
    };
  while (!Object.keys(cursor.parents).length) await prepareMergeStep(cursor, io, meter());
  delete cursor.generations;
  delete cursor.generationFallback;
  const oracle = await s.compose(cursor, { complete: true }),
    actual = await s.compose(cursor);
  assert.deepEqual(actual.output, oracle.output);
  assert.deepEqual(actual.headBytes, oracle.headBytes);
  assert.equal(actual.cursor.generationFallback, true);
  assert.equal(actual.cursor.ancestryCuts, undefined);
});

test('a direct older common side edge retains domination through the proven base', () => {
  const s = ancestryFixture({ generationMetadata: true }),
    nodes = [];
  const graph = [[], [0], [0], [0], [2], [0, 4], [1, 5], [1, 5], [0, 4], [2, 6]];
  for (const [i, parents] of graph.entries())
    nodes.push(
      s.state(
        [s.file('f', `v${i % 3}\n`)],
        parents.map(index => nodes[index]),
        `n${i}`,
      ),
    );
  const result = walk(s, [nodes[9], nodes[8]]);
  assert(result.cuts);
  assert(!result.cuts.includes(nodes[4]), 'the base retains edges proving older side ancestors dominated');
  assert.deepEqual(
    merge(s, nodes[9], nodes[8], result.parents, result.cuts),
    merge(s, nodes[9], nodes[8], s.parents),
  );
});

test('32000 verified private branches use a bounded number of generation lookups', t => {
  const count = 32000,
    parents = { L: [], R: ['U'], U: [] },
    levels = { L: 2, R: 2, U: 1 };
  for (let i = 0; i < count; i++) {
    const id = `W${i}`;
    parents.L.push(id);
    parents[id] = [];
    levels[id] = 1;
  }
  let lookups = 0;
  const generations = new Proxy(levels, {
    get(target, key) {
      assert(++lookups < count * 24, 'whole-frontier sorting regressed');
      return target[key];
    },
  });
  const started = performance.now(),
    result = sourceGenerationWalk(parents, generations, ['L', 'R']);
  assert.deepEqual(result, { frontier: [] });
  t.diagnostic(
    JSON.stringify({ states: count + 3, lookups, sourceRPCs: 0, wallMs: performance.now() - started }),
  );
});
