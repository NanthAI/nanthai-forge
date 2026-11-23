// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readChangeMap } from '../dist/change-map.js';

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
