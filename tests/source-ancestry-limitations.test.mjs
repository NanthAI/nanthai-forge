// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestryFixture } from './source-ancestry-fixture.mjs';
import { scaleFixture } from './convex-source-scale-fixture.mjs';
import { sourceAncestryCut, sourceAncestryFrontier } from '../dist/hosted-source-ancestry-cut.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';

function graph(kind, count, conflicting) {
  const s = ancestryFixture(),
    base = [s.file('f', 'base\n')],
    historical = [];
  for (let i = 0; i < count; i++)
    historical.push(s.state([], kind === 'closed-side' && i ? [historical[i - 1]] : [], `H${i}`));
  const c = s.state(base, kind === 'closed-side' ? historical.slice(-1) : historical, 'C'),
    b = s.state(base, [c], 'B');
  let shared = c;
  for (let i = 0; i < (kind === 'closed-side' ? 2 : 10); i++) shared = s.state(base, [shared], `Q${i}`);
  const u = s.state(base, [], 'U'),
    left = s.state([s.file('f', 'left\n')], [shared, b], 'M'),
    right = s.state(
      conflicting ? [s.file('f', 'right\n')] : [...base, s.file('r', 'right\n')],
      kind === 'closed-side' ? [shared, u] : [shared],
      'D',
    );
  return { s, left, right, initial: s.plan(left, [right]) };
}

// 48ba68ed-2690-4b41-967f-c12bf0e23ea0 owns the existing cut proof's
// closed-side limitation. BFS bounds speculative depth, not width. These are
// termination/byte-equivalence guards, deliberately without a cost bound.
for (const kind of ['closed-side', 'wide-closed-history'])
  for (const count of [0, 10, 400, 800])
    test(`${kind} ${count}: helper, persisted preparation and full worker terminate with oracle-equal bytes`, async t => {
      for (const conflicting of [false, true]) {
        const { s, left, right, initial } = graph(kind, count, conflicting),
          roots = [left, right],
          parents = {},
          remaining = new Set(roots);
        let boundary;
        while (remaining.size) {
          boundary = sourceAncestryCut(parents, [...remaining], roots);
          if (boundary) break;
          const frontier = sourceAncestryFrontier(parents, [...remaining], roots);
          assert(frontier.length, 'a finite valid graph must make progress');
          for (const id of frontier) {
            assert(!parents[id], 'each selected State is attempted once');
            parents[id] = s.parents[id];
            remaining.delete(id);
          }
          for (const id of frontier)
            for (const parent of parents[id]) if (!parents[parent]) remaining.add(parent);
        }
        const merge = (parents, boundary) => {
          const source = new MemoryMergeSource(structuredClone(parents), boundary);
          for (const [id, bytes] of s.objects) source.objects.set(id, bytes);
          const result = source.compose(left, right, 'merge', '2026-01-01T00:00:00.000Z');
          return {
            result,
            bytes: result.head ? source.object(result.head) : null,
            details: source.mergeFiles(left, right),
          };
        };
        assert.deepEqual(merge(parents, boundary), merge(s.parents));
        const oracle = await s.compose(initial, { complete: true }),
          selected = await s.compose(initial);
        assert.deepEqual(selected.output, oracle.output);
        assert.deepEqual(selected.headBytes, oracle.headBytes);
        const worker = await scaleFixture();
        try {
          for (const bytes of s.objects.values()) await worker.putSpec(bytes);
          const id = await worker.enqueue(initial.input),
            report = await worker.drain(),
            job = await worker.job(id);
          assert.equal(job.status, 'completed');
          assert.deepEqual(await worker.bytes(job.output), oracle.output);
          const result = JSON.parse(oracle.output).result;
          if (result.status === 'clean') assert.deepEqual(await worker.bytes(result.state), oracle.headBytes);
          else {
            let page = result.conflicts;
            while (page) {
              const bytes = await worker.bytes(page);
              assert.deepEqual(bytes, s.objects.get(page.sha256));
              page = JSON.parse(bytes).next;
            }
          }
          assert.equal(report.storageCalls, 0);
          t.diagnostic(JSON.stringify({ kind, count, conflicting, ...report }));
        } finally {
          worker.restore();
        }
      }
    });
