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

const model = await import(moduleUrl('../web/src/code-file-model.ts'));
const { treeCounts } = await import(moduleUrl('../web/src/CodeFileTree.tsx'));
test('Code tree dots, Lane tones, changed lines and symbols for the This file panels', () => {
  const lane = (id, tone, paths) => ({
    id,
    name: id,
    holder: id,
    agent: true,
    what: '',
    saves: 0,
    tone,
    href: '#',
    paths,
  });
  const touches = model.treeTouches([
    lane('whos', 'active', ['web/src/cockpit/LaneList.tsx', 'web/src/cockpit/Sessions.tsx']),
    lane('i4', 'failed', ['web/src/cockpit/LaneList.tsx', 'scripts/ui-shots.mjs']),
  ]);
  // A file and every folder above it carry the most urgent tone of the Lanes touching them.
  assert.deepEqual(touches.get('web/src/cockpit/LaneList.tsx'), { tone: 'failed', lanes: ['whos', 'i4'] });
  assert.deepEqual(touches.get('web/'), { tone: 'failed', lanes: ['whos', 'i4'] });
  assert.deepEqual(touches.get('web/src/cockpit/Sessions.tsx'), { tone: 'active', lanes: ['whos'] });
  assert.equal(touches.get('scripts/').tone, 'failed');
  assert.equal(touches.has('docs/'), false);
  assert.match(model.touchTitle(touches.get('web/')), /whos, i4/);

  const views = [{ id: 'v', inputs: [{ laneId: 'l', head: 'h2' }] }];
  const runs = [
    { viewId: 'v', status: 'failed', startedAt: '2026-10-20T10:00:00Z' },
    { viewId: 'v', status: 'passed', startedAt: '2026-10-20T11:00:00Z' },
  ];
  assert.equal(model.laneTone({ id: 'l', head: 'h2', assignment: 'gpt' }, views, runs), 'passed');
  // A Candidate of an older save says nothing about the current head.
  assert.equal(model.laneTone({ id: 'l', head: 'h3', assignment: 'gpt' }, views, runs), 'active');
  assert.equal(model.laneTone({ id: 'l', head: 'h3', assignment: '' }, views, runs), 'stale');

  const hunk = {
    afterStart: 40,
    lines: ['context', 'removed', 'added', 'added', 'context', 'added'].map(kind => ({ kind })),
  };
  assert.deepEqual(model.changedLines([hunk]), [
    [41, 42],
    [44, 44],
  ]);
  assert.equal(
    model.rangeLabel([
      [41, 58],
      [120, 120],
    ]),
    'L41–58, L120',
  );

  const text =
    'import { a } from "./a";\n\ntype Props = { a: number };\nexport const FOLD = 6;\nexport function List() {}\nconst fact = () => 1;\nexport default class Thing {}\n';
  assert.deepEqual(model.fileSymbols('x.tsx', text, 36), [
    { kind: 'type', name: 'Props', line: 38 },
    { kind: 'const', name: 'FOLD', line: 39 },
    { kind: 'fn', name: 'List', line: 40 },
    { kind: 'fn', name: 'fact', line: 41 },
    { kind: 'class', name: 'Thing', line: 42 },
  ]);
  assert.deepEqual(model.fileSymbols('notes.md', text), []);
  assert.equal(treeCounts(['README.md', 'web/src/a.ts', 'web/b.ts']), '3 files · 2 folders');
  assert.equal(treeCounts(['README.md']), '1 file · 0 folders');
});
