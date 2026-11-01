// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAncestryCut, sourceAncestryFrontier } from '../dist/hosted-source-ancestry-cut.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { parseNativeState } from '../dist/native-state-format.js';
import { digest } from '../dist/hash.js';
import { saveBytes } from '../dist/hosted-save.js';

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
