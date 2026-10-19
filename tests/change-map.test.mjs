// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readChangeMap } from '../dist/change-map.js';
import { moduleUrl } from './convex-module.mjs';
const { collapseChangeMap } = await import(moduleUrl('../web/src/lane/change-map-model.ts'));
const { codeGraphLayout } = await import(moduleUrl('../web/src/code-graph-layout.ts'));
const path = (name, status, before, after) => ({
  path: name,
  status,
  before: before ? { blob: before } : null,
  after: after ? { blob: after } : null,
});
test('Map includes one-hop importers/imports for every touched file, including deleted edges', async () => {
  const content = {
    a: 'import "./b"; export const a=1;',
    a2: 'import "./b"; export const a=2;',
    b: 'export const b=1;',
    c: 'import "./a";',
    d: 'import "./c";',
    gone: 'import "./b";',
  };
  const graph = await readChangeMap(
    'base',
    'head',
    [
      path('a.ts', 'modified', 'a', 'a2'),
      path('b.ts', 'unchanged', 'b', 'b'),
      path('c.ts', 'unchanged', 'c', 'c'),
      path('d.ts', 'unchanged', 'd', 'd'),
      path('gone.ts', 'deleted', 'gone', null),
    ],
    async ids => ids.map(id => Buffer.from(content[id])),
  );
  assert.deepEqual(
    graph.nodes.map(n => n.id),
    ['a.ts', 'b.ts', 'c.ts', 'gone.ts'],
  );
  assert.deepEqual(graph.edges, [
    { from: 'a.ts', to: 'b.ts' },
    { from: 'c.ts', to: 'a.ts' },
    { from: 'gone.ts', to: 'b.ts' },
  ]);
  assert.equal(graph.head, 'head');
  assert.ok(graph.nodes[0].add > 0);
  assert.ok(graph.nodes.at(-1).del > 0);
});
test('413 touched files group without loss, preserve coordination markers and expand', () => {
  const nodes = Array.from({ length: 413 }, (_, i) => ({
    id: `dir${i % 8}/file${i}.ts`,
    label: `file${i}.ts`,
    status: 'modified',
    add: i,
    del: 1,
    approximate: false,
  }));
  const data = { base: 'a', head: 'b', nodes, edges: [{ from: nodes[0].id, to: nodes[1].id }] };
  const markers = new Map([[nodes[0].id, ['other Lane']]]);
  const collapsed = collapseChangeMap(data, new Set(), markers);
  assert.equal(collapsed.nodes.length, 8);
  assert.equal(
    collapsed.nodes.reduce((n, p) => n + p.fileCount, 0),
    413,
  );
  assert.deepEqual(collapsed.nodes[0].marker, ['other Lane']);
  assert.equal(collapsed.edges.length, 1);
  const expanded = collapseChangeMap(data, new Set(['dir0']), markers);
  assert.equal(expanded.nodes.filter(n => n.status === 'modified').length, 52);
  assert.ok(expanded.nodes.find(n => n.id === nodes[0].id));
  for (const width of [300, 390, 1500])
    for (const p of codeGraphLayout(collapsed.nodes, width).positions.values())
      assert.ok(p.x >= 0 && p.x < width);
});
test('50 files remain individually reachable, empty Map stays empty', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({
    id: `${i}.ts`,
    label: `${i}.ts`,
    status: 'added',
    add: 1,
    del: 0,
    approximate: false,
  }));
  assert.equal(
    collapseChangeMap({ base: 'a', head: 'b', nodes, edges: [] }, new Set(), new Map()).groups.size,
    0,
  );
  assert.equal(
    collapseChangeMap({ base: 'a', head: 'b', nodes: [], edges: [] }, new Set(), new Map()).nodes.length,
    0,
  );
});

test('whole-file diffstats ignore the final newline sentinel', async () => {
  const graph = await readChangeMap(
    'a',
    'b',
    [path('new.txt', 'added', null, 'new'), path('gone.txt', 'deleted', 'gone', null)],
    async ids => ids.map(() => Buffer.from('one\n')),
  );
  assert.deepEqual(
    graph.nodes.map(n => [n.add, n.del]),
    [
      [1, 0],
      [0, 1],
    ],
  );
});

test('Map opts into content height without changing the Code graph default', () => {
  const nodes = [
    { id: 'a.ts', label: 'a.ts' },
    { id: 'b.ts', label: 'b.ts' },
  ];
  assert.equal(codeGraphLayout(nodes, 900).height, 480);
  assert.equal(codeGraphLayout(nodes, 900, 240).height, 240);
  assert.ok(
    codeGraphLayout(
      Array.from({ length: 20 }, (_, i) => ({ id: `${i}.ts`, label: `${i}.ts` })),
      390,
      240,
    ).height > 560,
  );
});
