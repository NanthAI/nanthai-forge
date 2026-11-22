// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { PageLinks, pagesFor } = await import(moduleUrl('../web/src/app/project-pages.tsx'));
const { parseAppPath } = await import(moduleUrl('../web/src/app/paths.ts'));
const { loadViews, removeView, saveView } = await import(moduleUrl('../web/src/app/plan/query.ts'));
const base = '/sample/tidepool';

test('a detail link marks the nearest page and keeps a real destination in the flyout', () => {
  const route = parseAppPath(base + '/code/files/src/index.ts');
  const { code } = pagesFor(route, undefined, [], undefined, '');
  assert.equal(code.find(page => page.current)?.href, base + '/code/files');
  assert.equal(code.find(page => page.current)?.current, 'true');
  const markup = renderToStaticMarkup(createElement(PageLinks, { pages: code, fly: true }));
  assert.match(markup, /href="\/sample\/tidepool\/code\/files" aria-current="true" tabindex="-1"/);
  assert.equal(markup.match(/aria-current=/g)?.length, 1);
});

test('Plan links preserve the reader’s order and layout and select one matching saved view', () => {
  const route = parseAppPath(base + '/plan');
  const saved = [
    { name: 'Release Bugs', query: '?type=bug&sort=status&view=tree' },
    { name: 'My bug list', query: '?type=bug' },
  ];
  const counts = { open: 41, mine: 12, unowned: 2 };
  const { plan } = pagesFor(route, 'sample', saved, counts, '?type=bug&sort=title&view=board');
  assert.deepEqual(
    plan.filter(page => page.current).map(page => [page.label, page.href]),
    [['Release Bugs', base + '/plan?type=bug&sort=title&view=board']],
  );
  assert.equal(
    plan.find(page => page.id === 'mine').href,
    base + '/plan?owner=%40sample&sort=title&view=board',
  );
  assert.equal(plan.find(page => page.id === 'mine').count, 12);
  assert.equal(
    pagesFor(route, undefined, saved, undefined, '').plan.some(page => page.id === 'mine'),
    false,
  );
  assert.equal(
    pagesFor(route, 'sample', saved, counts, '?type=docs').plan.some(page => page.current),
    false,
  );
});

test('saving and removing a view preserve newer views from another tab', t => {
  const stored = new Map();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const original = { name: 'Original', query: '?type=bug' };
  const otherTab = { name: 'From another tab', query: '?type=docs' };
  saveView('test-project', original);
  const earlier = loadViews('test-project');
  saveView('test-project', otherTab);
  assert.deepEqual(removeView('test-project', earlier, original.name), [otherTab]);
  assert.deepEqual(saveView('test-project', original), [original, otherTab]);
});
