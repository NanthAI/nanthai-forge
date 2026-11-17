// SPDX-License-Identifier: Apache-2.0
// The real public discovery screens (web/src/public/Discover.tsx) signed out, on synthetic cached public reads:
// counts reconcile with lists, a members-only plan and Lane titles without the opt-in never appear, star and clone
// ask for sign-in, a missing project and a private one look the same, and every page is axe-clean at 1440 and 390 in
// both themes. FORGE_DISCOVERY_SHOTS=<dir> also writes the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_DISCOVERY_SHOTS;
const NOW = Date.UTC(2026, 10, 17, 12);
const DAY = 86_400_000;

let age = 30;
const listed = (handle, slug, landings, stars, main = 'passing', name = slug) => ({
  id: `${handle}-${slug}`,
  handle,
  slug,
  name,
  since: NOW - (age += 9) * DAY,
  stars,
  landings,
  days: landings ? [1, 3, 0, 2, 4, 1, landings - 11 > 0 ? landings - 11 : 1] : [0, 0, 0, 0, 0, 0, 0],
  main,
});
const projects = [
  listed('ada', 'atlas', 42, 310),
  listed('ada', 'ledger', 12, 18),
  listed('kestrel-works', 'tern', 27, 96),
  listed('wren', 'quiet-tool', 0, 4, 'unchecked'),
  listed(
    'a-very-long-organisation-handle-for-testing',
    'an-unusually-long-project-name-that-must-wrap-or-cut',
    3,
    1_204_567,
    'unchecked',
  ),
];
const explore = order => ({
  v: 1,
  asOf: NOW,
  order,
  total: projects.length,
  more: false,
  projects: order === 'stars' ? [...projects].sort((a, b) => b.stars - a.stars) : projects,
});
const project = ({ plan = 'public', titles = false } = {}) => ({
  v: 1,
  asOf: NOW,
  project: { id: 'p1', handle: 'ada', slug: 'atlas', name: 'atlas', since: NOW - 60 * DAY },
  stars: 310,
  activity: { landings: 42, days: [3, 6, 4, 8, 7, 9, 5], main: 'passing', lastAt: NOW - 3_600_000 },
  lanes: {
    open: 3,
    more: false,
    editing: 1,
    saved: 0,
    checking: 1,
    ready: 1,
    held: 1,
    overlap: 0,
    titles: titles ? [{ stage: 'editing', title: 'Faster index rebuild' }] : [],
  },
  plan:
    plan === 'members'
      ? { shown: false }
      : {
          shown: true,
          left: 3,
          inProgress: 1,
          initiatives: [{ id: 'i1', title: 'Search', left: 2, inProgress: 1 }],
          next: [
            { id: 'a', title: 'Index rebuild without downtime', initiative: 'Search' },
            { id: 'b', title: 'Document the import format' },
          ],
        },
});
const reads = {
  '/-/public/v1/explore/active.json': explore('active'),
  '/-/public/v1/explore/stars.json': explore('stars'),
  '/-/public/v1/explore/newest.json': explore('newest'),
  '/-/public/v1/profile/ada.json': { v: 1, asOf: NOW, handle: 'ada', projects: projects.slice(0, 2) },
  '/-/public/v1/project/ada/atlas.json': project(),
  '/-/public/v1/project/ada/members.json': project({ plan: 'members' }),
  '/-/public/v1/project/ada/titled.json': project({ titles: true }),
};

async function fixture(out) {
  const entry = 'virtual:discovery-test';
  const source = `
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider, ConvexReactClient} from 'convex/react';
    import Discover from ${JSON.stringify(join(root, 'web/src/public/Discover.tsx'))};
    import {useRoute} from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const client = new ConvexReactClient('https://example.convex.cloud', {skipConvexDeploymentUrlCheck: true});
    function Root() { return h(Discover, {route: useRoute(), signedIn: false, viewerHandle: undefined}); }
    createRoot(document.getElementById('root')).render(h(ConvexProvider, {client}, h(Root)));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'discovery-fixture',
        resolveId(id) {
          if (id === entry) return '\0discovery-test.js';
        },
        load(id) {
          if (id === '\0discovery-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('discovery-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge</title><style>body{margin:0}</style>${styles}</head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
}

test('public discovery screens signed out: explore, profile and a public project page', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-discovery-'));
  const html = await fixture(out);
  const browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const asked = [];
  const open = async (path, width = 1440, theme = 'dark') => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    t.after(() => page.close());
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname.startsWith('/-/public/v1/')) {
        asked.push(url.pathname);
        assert.equal(route.request().method(), 'GET');
        assert.equal(route.request().headers().cookie, undefined, 'a public read sends no cookie');
        const body = reads[url.pathname];
        return route.fulfill(
          body
            ? { contentType: 'application/json', body: JSON.stringify(body) }
            : { status: 404, contentType: 'application/json', body: '{"found":false}' },
        );
      }
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'font/woff2';
      return route.fulfill(
        asset ? { contentType: type, body: readFileSync(file) } : { contentType: 'text/html', body: html },
      );
    });
    await page.goto(`https://forge.test${path}`);
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    await page.locator('h1').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    return page;
  };

  // Explore: the sentence's counts match the list; search filters people and projects; the order reads another file.
  const ex = await open('/-/explore');
  const sit = await ex.locator('.head .sit').textContent();
  assert.match(sit, /5 public projects\. 4 of them landed something this week\./);
  assert.equal(await ex.locator('.row.xrow').count(), 5);
  assert.match(await ex.locator('.tbar .n').textContent(), /^5 projects$/);
  await ex.getByRole('searchbox').fill('ada');
  assert.equal(await ex.locator('.row.xrow').count(), 2);
  assert.equal(await ex.locator('.row.hitrow').count(), 1, 'the person is found too');
  await ex.getByRole('searchbox').fill('zzz');
  assert.match(await ex.locator('.empty h3').textContent(), /No match/);
  await ex.getByRole('button', { name: 'Clear the search' }).click();
  await ex.getByRole('button', { name: 'Stars', exact: true }).click();
  await ex.waitForFunction(() =>
    document.querySelector('.row.xrow .pjn')?.textContent?.includes('a-very-long-organisation'),
  );
  assert.ok(asked.includes('/-/public/v1/explore/stars.json'));
  // A visitor's star asks for sign-in; nothing is starred.
  await ex.locator('.row.xrow .star').first().click();
  await ex.getByRole('dialog', { name: /Sign in to star/ }).waitFor();
  assert.match(
    await ex.getByRole('dialog').getByRole('link', { name: 'Sign in' }).getAttribute('href'),
    /^\/-\/signin\?next=%2F-%2Fexplore$/,
  );

  // A public project page: what was done, what is in progress, what is left; Next is derived from the plan.
  const pp = await open('/-/ada/atlas');
  const glance = await pp.locator('.glance p').textContent();
  assert.match(
    glance,
    /Main is passing\. 42 changes landed this week\. 3 Lanes are open now and 3 Items are left\./,
  );
  assert.match(
    await pp.locator('nav.pstate').textContent(),
    /42.*landings this week.*3.*open Lanes.*3.*open Items/s,
  );
  assert.equal(await pp.locator('.row.item').count(), 2);
  assert.match(
    await pp.getByRole('region', { name: 'Next' }).textContent(),
    /first 2 Planned Items of 3 left/,
  );
  assert.match(
    await pp.getByRole('region', { name: 'Open Lanes' }).textContent(),
    /shows open Lanes as counts/,
  );
  await pp.getByRole('button', { name: 'Clone' }).click();
  await pp.getByRole('dialog', { name: 'Sign in to clone atlas' }).waitFor();

  // Lane titles only with the opt-in; a members-only plan shows no plan, no Left and no Items.
  const titled = await open('/-/ada/titled');
  assert.match(
    await titled.getByRole('region', { name: 'Open Lanes' }).textContent(),
    /Faster index rebuild/,
  );
  const members = await open('/-/ada/members');
  const membersText = await members.locator('main').textContent();
  assert.match(membersText, /plan is for its members/);
  assert.doesNotMatch(membersText, /Items? (are|is) left|open Items|Index rebuild/);
  assert.equal(await members.locator('nav.pstate').count(), 0);

  // Missing and private look the same (the read answers 404 for both).
  const none = await open('/-/ada/private-one');
  assert.match(await none.locator('.empty h3').textContent(), /No public project at this address/);
  const nobody = await open('/-/nobody');
  assert.match(await nobody.locator('.empty h3').textContent(), /No one at @nobody/);

  // A profile lists only public projects, with the counts its sentence states.
  const pr = await open('/-/ada');
  assert.match(
    await pr.locator('.phead .say').textContent(),
    /^2 public projects, 54 landings this week, 328 stars\.$/,
  );
  assert.equal(await pr.locator('.row.xrow').count(), 2);

  for (const [name, path] of [
    ['explore', '/-/explore'],
    ['project', '/-/ada/atlas'],
    ['profile', '/-/ada'],
  ])
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        const page = await open(path, width, theme);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(scroll <= 0, `${name} ${width}/${theme}: no sideways scroll`);
        await page.addScriptTag({ path: axe });
        const violations = await page.evaluate(async () =>
          (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations.map(
            v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`,
          ),
        );
        assert.deepEqual(violations, [], `${name} ${width}/${theme}: axe`);
        if (shots)
          await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), fullPage: true });
      }
  assert.deepEqual(errors, []);
});
