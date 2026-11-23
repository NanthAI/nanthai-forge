// SPDX-License-Identifier: Apache-2.0
// The switch to the root (Item b0704959): every row of the route coverage audit (comment 91a32d6c on Item 84125787),
// and the earlier /- form of every app address, reaches its address at the root. Each request goes the way the site
// serves it (Item ef6aa22a): a static file first ("/" is web/index.html), else the site Worker (site/worker.ts: the
// cached public read when its path matches, else the app shell), then the app's own step before it renders
// (web/src/main.tsx: earlierAppPath, oldAddress).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';

const { earlierAppPath, parseAppPath } = await import(moduleUrl('../web/src/app/paths.ts'));
const { oldAddress } = await import(moduleUrl('../web/src/app/old-address.ts'));
const { serve: worker } = await import(moduleUrl('../site/worker.ts'));
const { isPublicReadPath } = await import(moduleUrl('../site/public-read.ts'));
const ORIGIN = 'https://site.example';
const APP = '<html><head><title>Forge</title></head><body></body></html>';
const LANE = '0f8d2c1e-5b7a-4c3d-9e21-6a4b8f0c7d35';
const short = (kind, id) => `${kind}-${Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url')}`;
// web/index.html's inline script: an old query link goes to the app's resolver; anything else is the static page.
const oldQuery =
  /[?&](project|codescape|zone|surface|tab|projectTab|collection|lane|intent|viewId|decision|review|planningItem)=/;

const env = { ASSETS: { fetch: async () => new Response(APP) }, FORGE_WEB_URL: ORIGIN };
const serve = request => worker(request, env);
function site(t) {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no backend read on the way to a page');
  });
}

/** Where an address ends: `{ at }` an app page (its route), `{ look }` an id-only link the app resolves with one
 * read, `{ page: '/' }` the static public page. `hops` counts browser loads. */
async function arrive(start) {
  let href = start;
  for (let hops = 0; hops < 6; hops++) {
    const url = new URL(href, ORIGIN);
    if (url.pathname === '/') {
      if (!oldQuery.test(url.search)) return { page: '/', hops };
      href = `/projects${url.search}`;
      continue;
    }
    const response = await serve(new Request(url));
    if (response.status >= 300 && response.status < 400) {
      href = response.headers.get('location');
      continue;
    }
    assert.equal(response.status, 200, `${start}: ${url.pathname}`);
    assert.equal(await response.text(), APP);
    const earlier = earlierAppPath(url.pathname);
    if (earlier) {
      href = earlier + url.search;
      continue;
    }
    const old = oldAddress(url.pathname, url.search);
    if (old?.kind === 'go') {
      href = old.to;
      continue;
    }
    if (old) return { look: old, hops };
    return { at: url.pathname + url.search, route: parseAppPath(url.pathname), hops };
  }
  assert.fail(`${start} did not settle`);
}

const p = '/ada/atlas';
// [audit address, where it ends]. A string is an app page at that address; 'look' an id-only link resolved in the app.
const rows = [
  ['/', 'static'],
  [`/?project=p1&lane=${LANE}`, 'look'],
  ['/?project=p1&projectTab=planning', 'look'],
  ['/?codescape=1', '/explore'],
  ['/?zone=src', '/explore'],
  ['/?surface=contact', '/account?surface=contact'],
  ['/projects', '/account'],
  ['/projects?request=r1&auth=existing', '/account?request=r1&auth=existing'],
  ['/projects?project=p1', 'look'],
  ['/settings', '/account/people'],
  ['/device', '/device'],
  ['/device?code=ABCDE-FGHJK', '/device?code=ABCDE-FGHJK'],
  ['/approve?project=p1&lane=l1', '/approve?project=p1&lane=l1'],
  ['/ada', '/ada'],
  ['/explore', '/explore'],
  [p, p],
  [`${p}/lanes`, `${p}/lanes`],
  [`${p}/lanes/${LANE}`, `${p}/lanes/${LANE}`],
  [`${p}/lanes/${short('l', LANE)}`, `${p}/lanes/${LANE}`],
  [`${p}/activity`, `${p}/needs-me/held`],
  [`${p}/intents`, `${p}/plan`],
  [`${p}/intents/${short('i', LANE)}`, `${p}/plan/${LANE}`],
  [`${p}/planning`, `${p}/plan`],
  [`${p}/views/${short('v', LANE)}`, `${p}/plan`],
  [`${p}/decisions`, `${p}/plan`],
  [`${p}/decisions/${short('d', LANE)}`, 'look'],
  [`${p}/review/${short('v', LANE)}`, 'look'],
  [`${p}/code`, `${p}/code`],
  [`${p}/code/src/a.ts`, `${p}/code/src/a.ts`],
  [`${p}/settings/access`, `${p}/settings`],
  [`${p}/settings/checks`, `${p}/settings/checks`],
  [`${p}/settings/autonomy`, `${p}/settings/checks`],
  [`${p}/settings/secrets`, `${p}/settings/secrets`],
  [`${p}/settings/you`, `${p}/settings/you`],
  [`${p}/settings/appearance`, `${p}/settings/you`],
  [`${p}/settings/github`, `${p}/settings/mirror`],
  [`${p}/settings/general`, `${p}/settings/project`],
  [`${p}/settings/backups`, `${p}/settings/project`],
  [`${p}/settings/transfer`, `${p}/settings/project`],
  [`${p}/settings/agents`, `${p}/settings/agents`],
  [`${p}/settings/contributions`, `${p}/lanes`],
  [`${p}/settings/devices`, '/account/devices'],
  // Local mode is not served by the hosted build: the address is no page, and `local` is never a handle.
  ['/local/demo', 'missing'],
];
// The app's own addresses while it lived under /- (mails, CLI output, board text and GitHub statuses carry them).
const earlier = [
  ['/-', '/account'],
  ['/-/account', '/account'],
  ['/-/account?request=r1', '/account?request=r1'],
  ['/-/account/people', '/account/people'],
  ['/-/signin?next=%2Fada', '/signin?next=%2Fada'],
  ['/-/signin/passkey', '/signin/passkey'],
  ['/-/device?code=ABCDE-FGHJK', '/device?code=ABCDE-FGHJK'],
  ['/-/approve?project=p1&lane=l1', '/approve?project=p1&lane=l1'],
  ['/-/new/import', '/new/import'],
  ['/-/terms', '/terms'],
  ['/-/explore', '/explore'],
  ['/-/ada', '/ada'],
  [`/-${p}`, p],
  [`/-${p}?view=needs`, `${p}?view=needs`],
  [`/-${p}/lanes/${LANE}?submission=s1`, `${p}/lanes/${LANE}?submission=s1`],
  [`/-${p}/lanes/${LANE}/checked`, `${p}/lanes/${LANE}/checked`],
  [`/-${p}/needs-me/held`, `${p}/needs-me/held`],
  [`/-${p}/code/files/src/a.ts`, `${p}/code/files/src/a.ts`],
  [`/-${p}/settings/mirror`, `${p}/settings/mirror`],
];

for (const [from, to] of [...rows, ...earlier])
  test(`b0704959: ${from} ends at ${to}`, async t => {
    site(t);
    const end = await arrive(from);
    if (to === 'static') return assert.deepEqual(end, { page: '/', hops: 0 });
    if (to === 'look') return assert.equal(end.look?.kind, 'look', JSON.stringify(end));
    if (to === 'missing') return assert.equal(end.route?.frame, 'missing', JSON.stringify(end));
    assert.equal(end.at, to);
    assert.notEqual(end.route.frame, 'missing', to);
    // One permanent redirect at most for an earlier /- address, then at most one app step for an old one.
    assert(end.hops <= 2, `${from}: ${end.hops} hops`);
  });

test('b0704959: the cached public read keeps /-/public/v1/ and is never redirected', async t => {
  site(t);
  const url = `${ORIGIN}/-/public/v1/explore/active.json`;
  assert(isPublicReadPath(url));
  const response = await serve(new Request(url));
  assert.equal(response.headers.get('location'), null);
  assert.notEqual(response.status, 301);
});

test('b0704959: an earlier /- address never redirects to another site', async t => {
  site(t);
  for (const path of [
    '/-//evil.example',
    '/-//evil.example/a/b',
    '/-///evil.example',
    '/-/%2fevil.example',
    '/-/%2F%2Fevil.example',
    '/-/%5Cevil.example',
    '/-/%5C%5Cevil.example',
    '/-/\\evil.example',
  ]) {
    const url = new URL(path, ORIGIN);
    assert(isPublicReadPath(url.href), `${path}: the cached public read answers it`);
    const response = await serve(new Request(url));
    assert.equal(response.status, 301, path);
    assert.equal(new URL(response.headers.get('location')).origin, ORIGIN, path);
    // The app's own step (main.tsx) stays on the site too.
    const earlier = earlierAppPath(url.pathname);
    assert.equal(new URL(earlier, ORIGIN).origin, ORIGIN, `${path} -> ${earlier}`);
  }
  // A doubled first slash misses the public read: the Worker serves the app, whose own step stays on the site.
  const doubled = new URL(`${ORIGIN}//-//evil.example`);
  assert.equal(isPublicReadPath(doubled.href), false);
  assert.equal(await (await serve(new Request(doubled))).text(), APP);
  assert.equal(earlierAppPath(doubled.pathname), '/evil.example');
  assert.equal(earlierAppPath('/-/\\evil.example'), '/evil.example');
  assert.equal(earlierAppPath('/-//\\/evil.example'), '/evil.example');
});

test('b0704959: the Worker answers its paths itself and leaves the static files alone', () => {
  // Static files are served before the Worker; a missing file runs it (no 404 page), and a file name without .html
  // serves that page (scripts/build-site.mjs). The one Worker-first route is "/", so the workers.dev address can
  // redirect its front door too (Item 702af738); every other static file stays free.
  const build = readFileSync(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8');
  assert.match(
    build,
    /assets: \{ htmlHandling: 'auto-trailing-slash', notFoundHandling: 'none', runWorkerFirst: \['\/'\] \}/,
  );
  assert.equal(build.match(/runWorkerFirst|run_worker_first/g).length, 1);
  for (const path of [
    '/-/public/v1/explore/active.json',
    '/sitemap.xml',
    '/-/account',
    '/explore',
    '/ada',
    '/ada/atlas',
  ])
    assert(isPublicReadPath(`${ORIGIN}${path}`), `${path} reaches the cached public read`);
  for (const path of [
    '/',
    '/docs',
    '/docs/',
    '/docs/status',
    '/docs/status/',
    '/assets',
    '/assets/app.js',
    '/llms.txt',
    '/robots.txt',
    '/favicon.svg',
  ])
    assert(!isPublicReadPath(`${ORIGIN}${path}`), `${path} stays a static file or the app`);
});
