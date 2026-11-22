// SPDX-License-Identifier: Apache-2.0
// Screen registration (Item 84125787, run C2): each screen folder registers its own addresses in `<folder>/route.ts`,
// so a new screen adds files and edits no shared one. A route file must never import its screen eagerly (that would
// put the screen in the first paint), every address keeps the screen it had in the shared registry, and the top-bar
// lane-stop names start with the words each stop shows. The CSS-responsive main name is checked in the browser.
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
const { projectPlaces, accountPlaces, hrefFor, parseAppPath } = await import(
  pathToFileURL(join(app, 'paths.ts')).href
);
const { Line, passedWaiting } = await import(moduleUrl('../web/src/app/Line.tsx'));
const { mainHealth } = await import(moduleUrl('../web/src/app/flow/model.ts'));

test('Flow names the destination for passed Lanes and dates main green from fresh audit evidence', () => {
  const at = new Date(2026, 10, 21, 16, 45).getTime();
  const yesterday = new Date(2026, 10, 20, 20, 50).getTime();
  const green = { red: false, since: yesterday, checkedAt: yesterday };
  assert.equal(passedWaiting(1_234), '1,234 passed, waiting to land');
  assert.deepEqual(mainHealth(green, at, at), {
    word: 'main green',
    state: 'passed',
    title: 'Latest full check of main passed at 16:45',
    red: null,
  });
  assert.equal(mainHealth(green, undefined, at).title, 'Latest full check of main passed');
  assert.equal(mainHealth({ ...green, since: at }, yesterday, at).title, 'Latest full check of main passed');
  // Red says since when where it is read and names its red view (Item 8d21cc9e), not only on hover.
  assert.deepEqual(mainHealth({ red: true, since: at, checkedAt: null, sequence: 7 }, yesterday, at), {
    word: 'main red since 16:45',
    state: 'failed',
    title: 'main red since 16:45',
    red: 7,
  });
  assert.equal(mainHealth({ red: true, since: null, checkedAt: null }, at, at).word, 'main red');
  assert.equal(mainHealth(null, at, at), null);
});

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
    [project('settings', 'project'), 'project-settings#0'],
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

test('e317b6ea: every address the Lanes overview and Sessions link resolves to its one owning screen', () => {
  // The links are built as the screens build them (Overview.tsx, SessionsView.tsx), then read back from the address
  // alone, as a reload, a shared link or browser Back would.
  const at = (section, rest = '') => hrefFor(project('lanes', section, rest));
  const cases = [
    [at(''), 'lanes#0'],
    [at('sessions'), 'sessions#0'],
    [at('sessions', 'mara/quiet-otter'), 'sessions#0'],
    [at('', lane), 'lane#0'],
    [at('', `${lane}/thread`), 'lane#0'],
    [at('', `${lane}/check`), 'check#0'],
    [at('', `${lane}/holder`), 'sessions#1'],
    [at('', `${lane}/checked`), 'proof#0'],
    [at('touching'), 'lanes#0'],
    [at('history'), 'lanes#0'],
  ];
  for (const [href, expected] of cases) {
    const route = parseAppPath(href);
    assert.equal(hrefFor(route), href, `${href} reads back as itself`);
    assert.equal(owner.get(projectScreenFor(entries, route)), expected, href);
  }
  // Only an address no screen serves is left to the Lanes place, which says so (LanesPlace.tsx).
  assert.equal(owner.get(projectScreenFor(entries, parseAppPath(at('', 'not/a/lane')))), 'lanes#0');
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

test('the Lane stops, desktop and phone, are named starting with the words they show', () => {
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
      const markup = renderToStaticMarkup(
        createElement(Line, { feed: value, handle: 'm', project: 'p', phone }),
      );
      assert.equal([...markup.matchAll(/<a href=/g)].length, 5);
      const stops = names(markup);
      assert.equal(stops.length, 4);
      for (const { name, shown } of stops)
        assert.ok(
          name.toLowerCase().replaceAll(',', '').startsWith(shown.toLowerCase().replaceAll(',', '')),
          `"${name}" must start with "${shown}"`,
        );
    }
  const desktop = names(renderToStaticMarkup(createElement(Line, { feed, handle: 'm', project: 'p' })));
  assert.deepEqual(
    desktop.map(stop => stop.name),
    [
      'Editing 1 Lane in this project',
      'Saved 0 Lanes in this project',
      'In queue 0 Lanes in this project',
      'Checking 0 Lanes, 2 Lanes passed, waiting to land, 1 held in this project',
    ],
  );
  const phone = names(
    renderToStaticMarkup(createElement(Line, { feed, handle: 'm', project: 'p', phone: true })),
  );
  assert.equal(phone[0].name, 'Edit 1 Lane in this project, editing');
});

test('recipient invitations have their own lazy account page', () => {
  assert.equal(owner.get(accountScreenFor(entries, 'people')), 'people#1');
});
