// SPDX-License-Identifier: Apache-2.0
// Screen registration (Item 84125787, run C2): each screen folder registers its own addresses in `<folder>/route.ts`,
// so a new screen adds files and edits no shared one. A route file must never import its screen eagerly (that would
// put the screen in the first paint), every address keeps the screen it had in the shared registry, and the top-bar
// line's accessible names start with the words each stop shows (axe label-content-name-mismatch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = join(root, 'web/src/app');
const routeFiles = readdirSync(app, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(app, entry.name, 'route.ts')))
  .map(entry => join(app, entry.name, 'route.ts'));
// Route files and the registry hold only erasable types, so Node loads them as they are; the test compiler would also
// compile every screen they lazily name.
const { projectScreenFor, accountScreenFor } = await import(pathToFileURL(join(app, 'screen-route.ts')).href);
const { projectPlaces, accountPlaces } = await import(pathToFileURL(join(app, 'paths.ts')).href);
const { Line } = await import(moduleUrl('../web/src/app/Line.tsx'));

const resolveTs = (from, spec) => {
  const base = resolve(dirname(from), spec);
  return ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => base + ext).find(path => existsSync(path));
};
const staticImports = source =>
  [...source.matchAll(/^\s*import\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/gm)]
    .filter(([, type]) => !type)
    .map(([, , spec]) => spec);

test('a route file never imports a screen eagerly: it is data, with type imports only and screens behind load()', () => {
  assert.ok(routeFiles.length >= 10, 'every current screen folder has a route file');
  for (const file of routeFiles) {
    const source = readFileSync(file, 'utf8');
    assert.deepEqual(
      staticImports(source),
      [],
      `${relative(root, file)} has a value import; load screens with load: () => import(...)`,
    );
    assert.doesNotMatch(
      source,
      /^\s*import\s+['"]/m,
      `${relative(root, file)} imports a module for its side effects`,
    );
    for (const [, spec] of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
      assert.ok(resolveTs(file, spec), `${relative(root, file)} loads missing ${spec}`);
  }
  // screens.tsx collects only route.ts: a route.tsx would be ignored silently.
  for (const entry of readdirSync(app, { withFileTypes: true }))
    if (entry.isDirectory())
      assert.ok(!existsSync(join(app, entry.name, 'route.tsx')), `${entry.name}/route.tsx: name it route.ts`);
});

const loaded = await Promise.all(
  routeFiles.map(async file => ({
    folder: relative(app, dirname(file)),
    entries: (await import(pathToFileURL(file).href)).default,
  })),
);
const entries = loaded.flatMap(({ entries }) => entries);
const owner = new Map(loaded.flatMap(({ folder, entries }) => entries.map((e, i) => [e, `${folder}#${i}`])));
const project = (place, section = '', rest = '') => ({
  frame: 'project',
  handle: 'mara',
  project: 'tide-pool',
  place,
  section,
  rest,
});
const lane = '0f8d2c1e-5b7a-4c3d-9e21-6a4b8f0c7d35';

test('every address keeps the screen the shared registry gave it, and project matches never overlap', () => {
  const cases = [
    [project('needs'), 'needs#0'],
    [project('needs', 'held'), 'needs#0'],
    [project('lanes'), 'lanes#0'],
    [project('lanes', 'history'), 'lanes#0'],
    [project('lanes', 'touching'), 'lanes#0'],
    [project('lanes', 'sessions'), 'sessions#0'],
    [project('lanes', '', `${lane}/holder`), 'sessions#1'],
    [project('lanes', '', `${lane}/checked`), 'proof#0'],
    [project('lanes', '', `${lane}/check`), 'check#0'],
    [project('lanes', '', lane), 'lane#0'],
    [project('lanes', '', 'not/a/lane'), 'lanes#0'],
    [project('plan'), 'plan#0'],
    [project('plan', '', 'i-AbCdEfGhIjKlMnOpQrStUv'), 'plan#0'],
    [project('code'), 'code#0'],
    [project('code', 'files', 'src/a.ts'), 'code#0'],
    [project('settings'), 'people#0'],
    [project('settings', 'checks'), 'checks#0'],
    [project('settings', 'secrets'), 'secrets#0'],
    [project('settings', 'project'), undefined],
    [project('stats'), 'stats#0'],
  ];
  for (const [route, expected] of cases) {
    assert.equal(owner.get(projectScreenFor(entries, route)), expected, JSON.stringify(route));
    const matches = entries.filter(e => e.place === route.place && e.match?.(route));
    assert.ok(matches.length <= 1, `overlapping matches for ${JSON.stringify(route)}`);
  }
  // An entry's place says its frame, so the two frames' place names must never coincide.
  assert.deepEqual(
    projectPlaces.filter(place => accountPlaces.includes(place)),
    [],
  );
  assert.equal(owner.get(accountScreenFor(entries, 'billing')), 'billing#0');
  assert.equal(owner.get(accountScreenFor(entries, 'devices')), 'devices#0');
  assert.equal(owner.get(accountScreenFor(entries, 'data')), 'data#0');
  // Account > Projects serves the bulk delete request page (Item 7456856f); the rest of the place is a placeholder.
  assert.equal(owner.get(accountScreenFor(entries, 'projects')), 'requests#0');
});

// The visible text as axe reads it: the anchor's text nodes joined as they are, so "Editing" and "1" with no text
// between them read as "Editing1".
const names = markup =>
  [...markup.matchAll(/<a [^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(([, name, inner]) => ({
    name,
    shown: inner
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));

test('each stop of the line, desktop and phone, is named starting with the words it shows', () => {
  const feed = {
    lanes: [
      { laneId: 'a', stage: 'editing', held: false, overlap: false, changedAt: 1 },
      { laneId: 'b', stage: 'ready', held: true, overlap: false, changedAt: 1 },
      { laneId: 'c', stage: 'ready', held: false, overlap: false, changedAt: 1 },
    ],
    more: 0,
    moreIsLowerBound: false,
    main: { head: 'abc' },
  };
  for (const phone of [false, true])
    for (const value of [feed, undefined]) {
      const stops = names(
        renderToStaticMarkup(createElement(Line, { feed: value, handle: 'm', project: 'p', phone })),
      );
      assert.equal(stops.length, 5);
      for (const { name, shown } of stops)
        assert.ok(name.toLowerCase().startsWith(shown.toLowerCase()), `"${name}" must start with "${shown}"`);
    }
  const desktop = names(renderToStaticMarkup(createElement(Line, { feed, handle: 'm', project: 'p' })));
  assert.deepEqual(
    desktop.map(stop => stop.name),
    ['Editing 1 Lane', 'Saved 0 Lanes', 'Checking 0 Lanes', 'Ready to land 2 Lanes, 1 held', 'main'],
  );
  const phone = names(
    renderToStaticMarkup(createElement(Line, { feed, handle: 'm', project: 'p', phone: true })),
  );
  assert.equal(phone[0].name, 'Edit 1 Lane, editing');
});

test('recipient invitations have their own lazy account page', () => {
  assert.equal(owner.get(accountScreenFor(entries, 'people')), 'people#1');
});
