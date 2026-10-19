// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { activityBursts } = await import(moduleUrl('../web/src/cockpit/activity-groups.ts'));

test('Activity folds only consecutive nearby saves from the same Lane without losing events', () => {
  const event = (id, laneId, at) => ({ id, laneId, at: at * 60_000 });
  const items = [
    event('save:1', 'a', 60),
    event('save:2', 'a', 50),
    event('save:3', 'b', 49),
    event('run:1', 'b', 48),
    event('save:4', 'b', 47),
    event('save:5', 'b', 1),
  ];
  const bursts = activityBursts(items);
  assert.deepEqual(
    bursts.map(group => group.length),
    [2, 1, 1, 1, 1],
  );
  assert.deepEqual(bursts.flat(), items);
});

const { codeImports } = await import(moduleUrl('../web/src/code-imports.ts'));
test('native Code import edges use declarations, ignore comments and unresolved modules', () => {
  const text =
    '// import fake from "./fake";\nimport { a } from "./a"; export * from "../shared"; const lazy = import("./lazy"); import external from "vendor";';
  assert.deepEqual(
    codeImports('src/main.ts', text, new Set(['src/a.ts', 'shared.ts', 'src/fake.ts', 'src/lazy.ts'])),
    [
      { from: 'src/main.ts', to: 'src/a.ts' },
      { from: 'src/main.ts', to: 'shared.ts' },
    ],
  );
  assert.deepEqual(codeImports('main.py', text, new Set(['src/a.ts'])), []);
});

const { codeGraphLayout, codeGraphEdge } = await import(moduleUrl('../web/src/code-graph-layout.ts'));
test('graph columns fit the container and edge endpoints stay on file cards', () => {
  const nodes = ['src/a.ts', 'web/b.ts', 'docs/c.ts', 'src/d.ts'].map(id => ({ id, label: id }));
  for (const width of [300, 390, 876, 1200]) {
    const layout = codeGraphLayout(nodes, width);
    for (const position of layout.positions.values()) {
      assert.ok(position.x >= 0);
      assert.ok(position.x + layout.cardWidth <= width);
    }
    const a = layout.positions.get('src/a.ts'),
      b = layout.positions.get('web/b.ts');
    const edge = codeGraphEdge(a, b, layout.cardWidth);
    assert.ok(edge.startsWith(`M${a.x + layout.cardWidth} ${a.y + 21}`));
    const targetX = a.x === b.x ? b.x + layout.cardWidth : b.x;
    assert.ok(edge.endsWith(`${targetX} ${b.y + 21}`));
  }
});
