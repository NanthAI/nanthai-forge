// SPDX-License-Identifier: Apache-2.0
// The real public discovery screens (web/src/public/Discover.tsx) signed out, on synthetic cached public reads:
// counts reconcile with lists, a members-only plan and Lane titles without the opt-in never appear, star and clone
// ask for sign-in, a missing project and a private one look the same, and every page is axe-clean at 1440 and 390 in
// both themes. The person's own page, signed in, adds their devices, sign-ins and stars, read once each and gone when
// they look at it as others do. FORGE_DISCOVERY_SHOTS=<dir> also writes the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';

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
  starLookup: true,
  asOf: NOW,
  order,
  total: projects.length,
  more: false,
  projects: order === 'stars' ? [...projects].sort((a, b) => b.stars - a.stars) : projects,
});
const sourceDeployment = 'https://source-project.convex.cloud';
const project = ({ plan = 'public', titles = false, upstream } = {}) => ({
  v: 1,
  asOf: NOW,
  deployment: sourceDeployment,
  starLookup: true,
  project: { id: 'p1', handle: 'ada', slug: 'atlas', name: 'atlas', since: NOW - 60 * DAY, upstream },
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
/** A year of a person's public work, as personDays.profile sends it signed out (Item 6a251b23). */
const contributions = (() => {
  const days = [];
  let seed = 7;
  const next = () => ((seed = (seed * 48271) % 2147483647) % 100) / 100;
  for (let i = 300; i >= 1; i--) {
    if (next() < 0.45) continue;
    const landings = Math.round(next() * 9);
    days.push([
      new Date(NOW - i * DAY).toISOString().slice(0, 10),
      landings,
      1 + Math.round(next() * 3),
      Math.round(next() * 2),
      Math.round(landings * 0.7),
      Math.round(next() * 2),
    ]);
  }
  const sum = k => days.reduce((n, d) => n + d[k], 0);
  const run = (run, model, lanes, landings, first, last, slug = 'atlas') => ({
    run,
    model,
    lanes,
    landings,
    first,
    last,
    project: { handle: 'ada', slug },
  });
  return {
    schema: 1,
    handle: 'ada',
    self: false,
    scope: 'public',
    through: days.at(-1)[0],
    first: Date.parse(`${days[0][0]}T08:00:00Z`),
    last: Date.parse(`${days.at(-1)[0]}T17:30:00Z`),
    days,
    totals: {
      landings: sum(1),
      lanes: sum(2),
      reviews: sum(3),
      landingsByAgents: sum(4),
      lanesByAgents: Math.round(sum(2) * 0.6),
      itemsClosed: sum(5),
    },
    projects: [
      {
        visibility: 'public',
        shared: false,
        handle: 'ada',
        slug: 'atlas',
        landings: sum(1) - 40,
        lanes: sum(2) - 20,
        reviews: sum(3),
        closed: sum(5),
        last: NOW - DAY,
      },
      {
        visibility: 'public',
        shared: false,
        handle: 'ada',
        slug: 'beacon',
        landings: 40,
        lanes: 20,
        reviews: 0,
        closed: 0,
        last: NOW - 9 * DAY,
      },
    ],
    projectsLeftOut: 0,
    closedPartial: false,
    agents: {
      total: 31,
      from: 0,
      rows: [
        run('amber-fox', 'sample-model-with-a-long-declared-name-1', 14, 11, days.at(-9)[0], days.at(-1)[0]),
        run('copper-moth', '', 3, 1, days.at(-30)[0], days.at(-20)[0], 'beacon'),
        run('keen-impala', 'sample-model-2', 6, 6, days.at(-60)[0], days.at(-41)[0]),
      ],
    },
    // A visitor's Latest: landings only (convex/personWork.ts).
    latest: [
      {
        kind: 'landed',
        at: NOW - 40 * 60_000,
        title:
          'Planner: push predicates below joins, a landing message somebody wrote without ever looking at where it would be shown',
        run: 'amber-fox',
        model: 'sample-model-with-a-long-declared-name-1',
        project: { handle: 'ada', slug: 'atlas' },
        target: '00000000-0000-4000-8000-000000000001',
      },
      {
        kind: 'landed',
        at: NOW - 2 * DAY,
        title: 'Types: infer nullable columns',
        run: null,
        model: null,
        project: { handle: 'ada', slug: 'beacon' },
        target: '00000000-0000-4000-8000-000000000002',
      },
    ],
  };
})();
/** The person's own Latest: also their open Lanes and comments. */
const ownLatest = [
  {
    kind: 'lane',
    at: NOW - 5 * 60_000,
    title: 'Split the adapter tests',
    run: 'copper-moth',
    model: null,
    project: { handle: 'ada', slug: 'ledger-private' },
    target: '00000000-0000-4000-8000-000000000003',
  },
  {
    kind: 'comment',
    at: NOW - 20 * 60_000,
    title: 'The join order flips when the left side is empty. Add that case before this lands.',
    run: null,
    model: null,
    project: { handle: 'ada', slug: 'atlas' },
    target: '00000000-0000-4000-8000-000000000004',
  },
  ...contributions.latest,
];
const nothing = {
  schema: 1,
  handle: 'kit',
  self: false,
  scope: 'public',
  through: null,
  first: null,
  last: null,
  days: [],
  totals: { landings: 0, lanes: 0, reviews: 0, landingsByAgents: 0, lanesByAgents: 0, itemsClosed: 0 },
  projects: [],
  projectsLeftOut: 0,
  closedPartial: false,
  agents: { total: 0, from: 0, rows: [] },
  latest: [],
};
/** What a signed-in person's own reads answer (Item 6a251b23): `?as=self` renders with these, never the network. */
const signed = {
  'personDays:profile': {
    ada: JSON.stringify({
      ...contributions,
      self: true,
      scope: 'all',
      projects: [
        ...contributions.projects,
        { ...contributions.projects[1], visibility: 'private', slug: 'ledger-private', landings: 3 },
      ],
      latest: ownLatest,
      // A busy day stopped counting planning work at a cap: Items closed shows as a floor.
      closedPartial: true,
    }),
    kit: JSON.stringify({ ...nothing, self: true, scope: 'all' }),
  },
  'authSessions:list': {
    sessions: [
      { sessionId: 's1', creationTime: NOW - 3 * 3_600_000, lastRefreshedAt: NOW, current: true },
      { sessionId: 's2', creationTime: NOW - 6 * DAY, lastRefreshedAt: NOW - DAY, current: false },
    ],
    passkeys: [],
    devices: [
      {
        credentialId: 'c1',
        name: 'Build laptop',
        scope: 'cli',
        issuedAt: NOW - 9 * DAY,
        expiresAt: NOW + 400 * DAY,
        revoked: false,
        code: 'dv-7f3k9q',
        approvedAt: NOW - 9 * DAY,
      },
      {
        credentialId: 'c2',
        name: 'Old box',
        scope: 'cli',
        issuedAt: NOW - 60 * DAY,
        expiresAt: NOW - 30 * DAY,
        revoked: false,
        code: 'dv-9t1b6h',
        approvedAt: NOW - 60 * DAY,
      },
      {
        credentialId: 'c4',
        name: 'Legacy box',
        scope: 'cli',
        issuedAt: NOW - 120 * DAY,
        expiresAt: NOW + 200 * DAY,
        revoked: false,
      },
      {
        credentialId: 'c3',
        name: 'Gone box',
        scope: 'cli',
        issuedAt: NOW - 90 * DAY,
        expiresAt: NOW - 60 * DAY,
        revoked: true,
        removed: true,
        code: 'dv-gone00',
      },
    ],
    github: null,
    notice: null,
    isDone: true,
    continueCursor: '',
  },
  'publicDiscovery:myStarred': { projects: [projects[2]], more: false },
  'publicDiscovery:myStars': [projects[2].id],
};
const reads = {
  '/-/public/v1/profile/kit.json': { v: 1, asOf: NOW, handle: 'kit', projects: [], contributions: nothing },
  '/-/public/v1/explore/active.json': explore('active'),
  '/-/public/v1/explore/stars.json': explore('stars'),
  '/-/public/v1/explore/newest.json': explore('newest'),
  '/-/public/v1/profile/ada.json': {
    v: 1,
    asOf: NOW,
    handle: 'ada',
    projects: projects.slice(0, 2),
    contributions,
  },
  '/-/public/v1/project/ada/atlas.json': project(),
  '/-/public/v1/project/ada/legacy.json': { ...project(), starLookup: undefined, deployment: undefined },
  '/-/public/v1/project/ada/fork.json': project({ upstream: { handle: 'wren', slug: 'original-atlas' } }),
  '/-/public/v1/project/ada/fork-unavailable.json': project({ upstream: null }),
  '/-/public/v1/project/ada/members.json': project({ plan: 'members' }),
  '/-/public/v1/project/ada/titled.json': project({ titles: true }),
  '/-/public/v1/project/ada/partial.json': {
    ...project(),
    activity: { ...project().activity, recordedSince: NOW - 2 * DAY },
  },
};

async function fixture(out) {
  const entry = 'virtual:discovery-test';
  const source = `
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider, ConvexReactClient} from 'convex/react';
    import {getFunctionName} from 'convex/server';
    import Discover from ${JSON.stringify(join(root, 'web/src/public/Discover.tsx'))};
    import {useRoute} from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const signed = ${JSON.stringify(signed)};
    const viewer = new URLSearchParams(location.search).get('as');
    const self = viewer === 'self' || viewer === 'owner-after-removal';
    const signedIn = self || viewer === 'visitor';
    const mine = new Set(signed['publicDiscovery:myStars']);
    const watchers = new Set();
    let stars = 310;
    window.writes = [];
    const answer = (name, args) => {
      if (name === 'publicDiscovery:myStars') {
        if (location.pathname.endsWith('/legacy') && args.projectIds) throw new Error('old server rejects new lookup args');
        return args.projectIds ? args.projectIds.filter(id => mine.has(id)) : [...mine];
      }
      if (name === 'publicDiscovery:stargazers') {
        if (!self) throw new Error('only the owner should request stargazers');
        if (viewer === 'owner-after-removal') throw new Error('the project is unavailable');
        return args.paginationOpts.cursor === null 
          ? { page: [{handle: 'wren'}], isDone: false, continueCursor: 'second-page' } 
          : { page: [{handle: 'kit'}], isDone: true, continueCursor: '' };
      }
      if (!(name in signed)) throw new Error('unexpected read ' + name);
      return name === 'personDays:profile' ? signed[name][args.handle] : signed[name];
    };
    // Signed in as the person: every read is answered here and counted; nothing reaches a server.
    window.asked = [];
    const noop = () => {};
    const fake = {
      query: async (ref, args) => (window.asked.push(getFunctionName(ref)), answer(getFunctionName(ref), args)),
      watchQuery: (ref, args) => ({
        onUpdate: notify => (watchers.add(notify), () => watchers.delete(notify)),
        localQueryResult: () => answer(getFunctionName(ref), args),
        journal: noop,
      }),
      mutation: async (ref, args) => {
        if (getFunctionName(ref) !== 'publicDiscovery:star') throw new Error('unexpected mutation');
        window.writes.push(args);
        if (mine.has(args.projectId) !== args.starred) {
          stars += args.starred ? 1 : -1;
          args.starred ? mine.add(args.projectId) : mine.delete(args.projectId);
        }
        for (const update of watchers) update();
        return { starred: args.starred, stars };
      },
      action: async () => null,
      logger: { warn: noop, log: noop, error: noop, logVerbose: noop },
      connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false }),
      subscribeToConnectionState: () => noop,
    };
    const client = signedIn ? fake : new ConvexReactClient('https://example.convex.cloud', {skipConvexDeploymentUrlCheck: true});
    function Root() { return h(Discover, {route: useRoute(), signedIn, viewerHandle: self ? 'ada' : signedIn ? 'wren' : undefined}); }
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

test('public discovery screens: explore, a profile signed out and as its person, and a public project page', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-discovery-'));
  const html = await fixture(out);
  const browser = await chromium.launch(launchOptions);
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

  const cloneGate = pp.getByRole('dialog', { name: 'Sign in to clone atlas' });
  const next = '/-/ada/atlas?view=public';
  assert.equal(
    await pp.getByRole('banner').getByRole('link', { name: 'Sign in' }).getAttribute('href'),
    `/-/signin?next=${encodeURIComponent(next)}`,
  );
  assert.equal(
    await cloneGate.getByRole('link', { name: 'Sign in' }).getAttribute('href'),
    `/-/signin?next=${encodeURIComponent(next)}`,
  );
  await cloneGate.getByRole('button', { name: 'Not now' }).click();
  await pp.getByRole('button', { name: /Star .* for ada\/atlas/ }).click();
  const starGate = pp.getByRole('dialog', { name: 'Sign in to star atlas' });
  assert.equal(
    await starGate.getByRole('link', { name: 'Sign in' }).getAttribute('href'),
    `/-/signin?next=${encodeURIComponent(next)}`,
  );
  assert.equal(await pp.getByRole('button', { name: 'Who starred' }).count(), 0);

  // A signed-in visitor can star, unstar, and clone without leaving the public page.
  const visitor = await open(`${next}&as=visitor`);
  const star = visitor.getByRole('button', { name: /Star .* for ada\/atlas/ });
  await star.click();
  await visitor.getByRole('button', { name: 'Star 311 stars for ada/atlas', pressed: true }).waitFor();
  await star.click();
  await visitor.getByRole('button', { name: 'Star 310 stars for ada/atlas', pressed: false }).waitFor();
  assert.deepEqual(await visitor.evaluate(() => window.writes), [
    { projectId: 'p1', starred: true },
    { projectId: 'p1', starred: false },
  ]);
  assert.equal(await visitor.getByRole('button', { name: 'Who starred' }).count(), 0);
  await visitor.getByRole('button', { name: 'Clone' }).click();
  const clone = visitor.getByRole('dialog', { name: 'Clone atlas' });
  await clone.waitFor();
  assert.deepEqual(await clone.locator('code').allTextContents(), [
    `nforge login '${sourceDeployment}'`,
    `nforge clone 'https://forge.test/-/ada/atlas' 'atlas' --deployment '${sourceDeployment}'`,
  ]);

  // The owner's view requests and paginates handles only when opened.
  const owner = await open(`${next}&as=self`);
  assert.equal(await owner.getByRole('link', { name: '@wren' }).count(), 0);
  await owner.getByRole('button', { name: 'Who starred' }).click();
  const people = owner.getByRole('dialog', { name: 'Who starred' });
  await people.getByRole('link', { name: '@wren' }).waitFor();
  await people.getByRole('button', { name: 'Show more' }).click();
  await people.getByRole('link', { name: '@kit' }).waitFor();
  assert.equal(await people.getByRole('link', { name: '@wren' }).getAttribute('href'), '/-/wren');

  const removed = await open(`${next}&as=owner-after-removal`);
  await removed.getByRole('button', { name: 'Who starred' }).click();
  await removed.getByRole('alert').filter({ hasText: 'Could not read who starred this project.' }).waitFor();
  await removed.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  assert.equal(await removed.getByRole('heading', { level: 1 }).count(), 1);

  const legacy = await open('/-/ada/legacy?view=public&as=visitor');
  await legacy.getByRole('button', { name: 'Clone' }).click();
  assert.equal(
    await legacy.getByRole('dialog').locator('code').textContent(),
    "nforge clone --find 'ada/atlas' --site 'https://forge.test'",
  );

  const fork = await open('/-/ada/fork');
  assert.match(await fork.locator('.phead .fl').textContent(), /Forked from wren\/original-atlas/);
  assert.equal(
    await fork.getByRole('link', { name: 'wren/original-atlas' }).getAttribute('href'),
    '/-/wren/original-atlas?view=public',
  );
  const forkUnavailable = await open('/-/ada/fork-unavailable');
  assert.match(
    await forkUnavailable.locator('.phead .fl').textContent(),
    /Forked from a project that is no longer available/,
  );
  assert.equal(await forkUnavailable.locator('.phead .fl a').count(), 0);

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

  const partial = await open('/-/ada/partial');
  assert.match(await partial.locator('.glance').textContent(), /42 changes recorded this week/);
  assert.match(await partial.locator('nav.pstate').textContent(), /recorded since/);
  assert.match(await partial.getByRole('region', { name: 'Open Lanes' }).textContent(), /Recorded/);

  // Missing and private look the same (the read answers 404 for both).
  const none = await open('/-/ada/private-one');
  assert.match(await none.locator('.empty h3').textContent(), /No public project at this address/);
  const nobody = await open('/-/nobody');
  assert.match(await nobody.locator('.empty h3').textContent(), /No one at @nobody/);

  // A profile lists only public projects; its head says the first and last activity in them (Item 6a251b23).
  const pr = await open('/-/ada');
  assert.match(await pr.locator('.phead .fl').textContent(), /^First activity .+Last activity .+$/);
  assert.equal(await pr.locator('.row.xrow').count(), 2);
  // Its contributions come from the cached read: figures, a day grid, the agents with declared models, and where.
  assert.match(await pr.locator('.nums.pick').textContent(), new RegExp(`${contributions.totals.landings}`));
  assert.equal((await pr.locator('.cal .cw').count()) > 30, true);
  assert.match(await pr.locator('[aria-label=Agents]').textContent(), /amber-fox[\s\S]*model not declared/);
  assert.match(await pr.locator('[aria-label=Agents]').textContent(), /Sign in to page through the rest/);
  // Four figures, Items closed second; Latest shows the visitor's landings with who did it.
  assert.deepEqual(
    (await pr.locator('.nums.pick button span').allTextContents()).map(text => text.replace(/^\d.*? /, '')),
    ['landings', 'Items closed', 'Lanes', 'reviews'],
  );
  await pr.locator('.nums.pick button').nth(1).click();
  assert.match(await pr.locator('[aria-label=Contributions] h2').textContent(), /Items closed per day/);
  const latest = await pr.getByRole('region', { name: 'Latest' }).textContent();
  assert.match(latest, /Planner: push predicates[\s\S]*amber-fox[\s\S]*Landed/);
  assert.doesNotMatch(latest, /In progress|Commented/);
  assert.doesNotMatch(
    await pr.locator('.nums.pick button').nth(1).textContent(),
    /\+/,
    'fully counted: no floor mark',
  );
  assert.match(await pr.getByRole('region', { name: 'Where' }).textContent(), /Items closed/);
  assert.doesNotMatch(await pr.locator('main').textContent(), /private|Private/);

  // The person's own page: their devices and browsers (codes, never device names, a device with no code reads "without a code"; removed devices gone), their
  // stars, and every project they worked on, each read asked once. Seen as others do, the private parts go.
  const me = await open('/-/ada?as=self');
  assert.match(await me.getByRole('link', { name: 'Manage' }).getAttribute('href'), /\/account\/devices$/);
  const devices = await me
    .getByRole('region', { name: 'Devices and places you are signed in' })
    .textContent();
  assert.match(devices, /Devices and sign-ins5only you see this/);
  assert.match(devices, /dv-7f3k9qSigned in until/);
  assert.match(devices, /dv-9t1b6hSign-in expired/);
  assert.match(devices, /A browsersigned in .+ · this browser/);
  assert.match(devices, /Devicewithout a codeSigned in until/);
  assert.doesNotMatch(devices, /Build laptop|Old box|Legacy box|dv-gone00/);
  assert.match(await me.getByRole('region', { name: 'Starred' }).textContent(), /kestrel-works.*tern/s);
  assert.match(await me.getByRole('region', { name: 'Where' }).textContent(), /ledger-private.*Private/s);
  const own = await me.getByRole('region', { name: 'Latest' }).textContent();
  assert.match(own, /Split the adapter tests[\s\S]*In progress[\s\S]*The join order flips[\s\S]*Commented/);
  assert.match(
    await me.locator('.nums.pick button').nth(1).textContent(),
    /\d\+Items? closed/,
    'a capped day: a floor',
  );
  // Quiet: a hover on the "+" says why, nothing else on the page does.
  assert.match(
    (await me.locator('.nums.pick button').nth(1).locator('span[title]').getAttribute('title')) ?? '',
    /older days are counted from what is still kept/,
  );
  assert.deepEqual((await me.evaluate(() => window.asked)).sort(), [
    'authSessions:list',
    'personDays:profile',
    'publicDiscovery:myStarred',
  ]);
  await me.getByRole('button', { name: 'See it as others do' }).click();
  assert.equal(await me.getByRole('region', { name: 'Devices and places you are signed in' }).count(), 0);
  assert.equal(await me.getByRole('region', { name: 'Starred' }).count(), 0);
  assert.doesNotMatch(await me.locator('main').textContent(), /ledger-private/);
  // Your own page with nothing yet says what will show and how to start, and still lists your devices.
  const fresh = await open('/-/kit?as=self');
  assert.match(await fresh.getByRole('region', { name: 'Contributions' }).textContent(), /Nothing yet/);
  await fresh.getByRole('link', { name: 'Import a repository' }).waitFor();
  await fresh.getByRole('region', { name: 'Devices and places you are signed in' }).waitFor();

  for (const [name, path] of [
    ['explore', '/-/explore'],
    ['project', '/-/ada/atlas'],
    ['profile', '/-/ada'],
    ['profile-self', '/-/ada?as=self'],
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
