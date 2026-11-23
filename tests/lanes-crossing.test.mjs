// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who is touching what by pair (Item df1f2d46): the owner saw 543 shared files listed one by one, each followed by a
// paragraph of Item titles with the same Item repeated per Lane, and a "−" that looked like a fold and did nothing.
// Pairs of Items replace it: an Item is named once with its Lane count, a reported conflict ranks first, an Item's
// own Lanes are a quiet line and not a pair, files group by folder, and every fold is a real button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { crossPairs, byFolder, mostlyOne, pairPaths } = await import(
  moduleUrl('../web/src/app/lanes/cross-pairs.ts')
);
const { CrossList } = await import(moduleUrl('../web/src/app/lanes/Crossing.tsx'));

const item = { l1: 'licence', l2: 'licence', l3: 'licence', t1: 'trust', p1: 'speed', p2: 'speed' };
const titles = { licence: 'Licence', trust: 'Trust and safety', speed: 'P0 speed budget' };
const sideOf = laneId => ({ key: item[laneId] ?? laneId, title: titles[item[laneId]] ?? `Lane ${laneId}` });
const file = (path, ...laneIds) => ({ path, laneIds });

test('df1f2d46: an Item with several Lanes is one side, named once, with its Lanes listed', () => {
  const files = [file('convex/a.ts', 'l1', 'l2', 't1'), file('convex/b.ts', 'l3', 't1')];
  const pairs = crossPairs(files, sideOf, () => false);
  const cross = pairs.filter(pair => pair.b);
  assert.equal(cross.length, 1, 'Licence and Trust are one pair, not one per Licence Lane');
  assert.deepEqual([cross[0].a.title, cross[0].b.title].sort(), ['Licence', 'Trust and safety']);
  const licence = cross[0].a.key === 'licence' ? cross[0].aLanes : cross[0].bLanes;
  assert.deepEqual(licence, ['l1', 'l2', 'l3']);
  assert.equal(cross[0].files, 2);
  assert.deepEqual(pairPaths(files, cross[0]), ['convex/a.ts', 'convex/b.ts']);
});

test("df1f2d46: an Item's own Lanes crossing each other are not ranked against another Item", () => {
  const pairs = crossPairs(
    [file('docs/x.md', 'l1', 'l2'), file('docs/y.md', 'l1', 'l3')],
    sideOf,
    () => false,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].b, null, 'the same work, so a line of its own');
  assert.deepEqual(pairs[0].aLanes, ['l1', 'l2', 'l3']);
  assert.deepEqual(pairPaths([file('docs/x.md', 'l1', 'l2'), file('docs/z.md', 'l1', 't1')], pairs[0]), [
    'docs/x.md',
  ]);
});

test('df1f2d46: pairs with a conflict rank first, then by shared files, however many of their Lanes conflict', () => {
  const files = [
    ...Array.from({ length: 40 }, (_, i) => file(`convex/f${i}.ts`, 'l1', 't1')),
    ...Array.from({ length: 3 }, (_, i) => file(`src/one-side-${i}.ts`, 'l2', 'p1')),
    file('src/both-sides.ts', 'l3', 'p2'),
  ];
  const pairs = crossPairs(files, sideOf, laneId => ['p1', 'p2', 'l3'].includes(laneId));
  assert.deepEqual(
    pairs.map(pair => [pair.files, pair.conflicted.length > 0]),
    [
      [4, true],
      [40, false],
    ],
    'Licence and P0 share 4 files across two Lane pairs; one conflicting Lane is enough to rank them first',
  );
  const split = crossPairs(
    [...Array.from({ length: 3 }, (_, i) => file(`a/${i}`, 'x', 'y')), file('b/0', 'u', 'v')],
    laneId => ({ key: laneId, title: laneId }),
    laneId => ['x', 'u', 'v'].includes(laneId),
  );
  assert.deepEqual(
    split.map(pair => pair.key),
    ['x\ny', 'u\nv'],
    'a pair with both sides conflicting does not outrank a larger pair with one',
  );
});

test('df1f2d46: files group by folder, most files first, top-level files in their own group', () => {
  assert.deepEqual(byFolder(['web/a.ts', 'convex/b.ts', 'README.md', 'convex/a.ts']), [
    { dir: 'convex/', names: ['b.ts', 'a.ts'] },
    { dir: '', names: ['README.md'] },
    { dir: 'web/', names: ['a.ts'] },
  ]);
});

test('df1f2d46: the one-Item fact shows only when one Item is in at least half the shared files', () => {
  const most = [file('a', 'l1', 't1'), file('b', 'l2', 'p1'), file('c', 't1', 'p1')];
  assert.deepEqual(mostlyOne(most, sideOf), { side: sideOf('l1'), files: 2 });
  const spread = [file('a', 'l1', 't1'), file('b', 'p1', 'x'), file('c', 'y', 'z'), file('d', 'w', 'v')];
  assert.equal(mostlyOne(spread, sideOf), null);
  assert.equal(mostlyOne([file('a', 'l1', 'l2'), file('b', 'l1', 'l3')], sideOf), null, 'one Item alone');
});

test('df1f2d46: 50 Lanes on 5,000 files make at most one entry per pair of Items', () => {
  const lanes = Array.from({ length: 50 }, (_, i) => `lane-${i}`);
  const files = Array.from({ length: 5000 }, (_, i) => file(`d${i % 40}/f${i}.ts`, ...lanes));
  const pairs = crossPairs(
    files,
    laneId => ({ key: laneId, title: laneId }),
    () => false,
  );
  assert.equal(pairs.length, (50 * 49) / 2);
  assert.ok(pairs.every(pair => pair.files === 5000));
  assert.ok(
    pairs.every(pair => !('paths' in pair)),
    'a pair holds a count, not 5,000 paths each (6 million for the whole list)',
  );
});

test('df1f2d46: the list shows six pairs, folds that are buttons, and an Item crossing itself as one line', () => {
  const files = [
    ...['t1', 'p1', 'x', 'y', 'z', 'w', 'v', 'u'].map(other => file(`src/${other}.ts`, 'l1', other)),
    file('docs/own.md', 'l2', 'l3'),
  ];
  const all = crossPairs(files, sideOf, () => false);
  const html = renderToStaticMarkup(
    h(CrossList, {
      pairs: all.filter(pair => pair.b),
      own: all.filter(pair => !pair.b),
      shared: files,
      laneHref: id => `/lanes/${id}`,
      conflicted: () => false,
    }),
  ).replaceAll('<!-- -->', '');
  assert.equal(html.match(/class="cx-pair"/g).length, 6);
  assert.equal(html.match(/aria-expanded="false"/g).length, 6, 'every pair is a real fold');
  for (const [, id] of html.matchAll(/aria-controls="([^"]+)"/g))
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*hidden`),
      `a shut fold still names a target that exists: ${id}`,
    );
  assert.match(html, /Showing 6 of 8 pairs\. <button[^>]*>Show 2 more pairs<\/button>/);
  assert.match(html, /Licence<\/span> has 2 open Lanes sharing 1 file:/);
  assert.doesNotMatch(html, /Same file</, 'no per-file wall and no dead "−" state glyph');
  assert.equal(html.match(/>Licence</g).length, 7, 'each row names Licence once, never once per Lane');
});
