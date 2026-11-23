// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Old addresses (Item d61f36fe): every address the old site served maps to its place in the rebuilt app, with no read
// for a plain path; an address that names only ids is handed to the resolver with the ids it must look up. Targets are
// built from paths.ts; the app is at the root since Item b0704959.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { oldAddress, lookHref } = await import(moduleUrl('../web/src/app/old-address.ts'));
const { ROOT, hrefFor, isAppPath, parseAppPath } = await import(moduleUrl('../web/src/app/paths.ts'));
const { safeNext } = await import(moduleUrl('../web/src/app/session.ts'));
const { reservedHandles } = await import(moduleUrl('../src/readable-urls.ts'));

const LANE = '0f8d2c1e-5b7a-4c3d-9e21-6a4b8f0c7d35';
// The old codec's short ids: kind letter, then the 16 bytes of the id in 22 URL-safe characters (src/project-routes.ts).
const short = (kind, id) => `${kind}-${Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url')}`;
const project = (place, section = '', rest = '') =>
  hrefFor({ frame: 'project', handle: 'mara', project: 'tide-pool', place, section, rest });
const base = '/mara/tide-pool';

// [old pathname, old search, the new address]; the new address is "go" to there.
const paths = [
  ['/projects', '', hrefFor({ frame: 'account', place: 'projects' })],
  // A delete-request link keeps its request.
  [
    '/projects',
    '?request=r1&auth=existing',
    `${hrefFor({ frame: 'account', place: 'projects' })}?request=r1&auth=existing`,
  ],
  ['/settings', '', hrefFor({ frame: 'account', place: 'people' })],
  ['/projects', '?surface=account', hrefFor({ frame: 'account', place: 'people' })],
  [`${base}/activity`, '', project('needs', 'held')],
  [`${base}/intents`, '', project('plan')],
  [`${base}/intents/${short('i', LANE)}`, '', project('plan', '', LANE)],
  [`${base}/work/${short('i', LANE)}`, '', project('plan', '', LANE)],
  [`${base}/planning`, '', project('plan')],
  [`${base}/planning`, '?planningItem=abcd1234', project('plan', '', 'abcd1234')],
  // A saved view's id has no address of its own in the rebuilt Plan: the Plan opens.
  [`${base}/views/${short('v', LANE)}`, '', project('plan')],
  [`${base}/views`, '', project('plan')],
  [`${base}/decisions`, '', project('plan')],
  // The old codec wrote short Lane ids; the rebuilt Lane page reads the full id.
  [`${base}/lanes/${short('l', LANE)}`, '', project('lanes', '', LANE)],
  // The exact State of a file link is the rebuilt `?at=`.
  [
    `${base}/code/src/a.ts`,
    `?head=${'a'.repeat(64)}`,
    `${project('code', 'files', 'src/a.ts')}?at=${'a'.repeat(64)}`,
  ],
  [`${base}/lanes/${short('l', LANE)}/check`, '', project('lanes', '', `${LANE}/check`)],
  // Settings pages with a rebuilt screen.
  [`${base}/settings/access`, '', project('settings')],
  [`${base}/settings/autonomy`, '', project('settings', 'checks')],
  [`${base}/settings/appearance`, '', project('settings', 'you')],
  [`${base}/settings/github`, '', project('settings', 'mirror')],
  [`${base}/settings/devices`, '', hrefFor({ frame: 'account', place: 'devices' })],
  // Pages whose rebuilt screen has landed (Settings > Project: Item 966cb821).
  [`${base}/settings/general`, '', project('settings', 'project')],
  [`${base}/settings/sharing`, '', project('settings', 'project')],
  [`${base}/settings/backups`, '', project('settings', 'project')],
  [`${base}/settings/transfer`, '', project('settings', 'project')],
  // Dropped screens and the page that replaced one (Item f2ee8381). Guidance is the rebuilt Settings > Agents;
  // contributions are rebuilt with the fork work (d1303286), so their old page opens Lanes, where offered work is read;
  // an import's explorer, its source zones and the code map open Explore, which covers discovery.
  [`${base}/settings/contributions`, '', project('lanes')],
  ['/', '?codescape=1', hrefFor({ frame: 'discover', page: 'explore' })],
  ['/projects', '?codescape=1&tour=1', hrefFor({ frame: 'discover', page: 'explore' })],
  ['/', '?codescape=1&zone=src&view=map', hrefFor({ frame: 'discover', page: 'explore' })],
  ['/', '?zone=src', hrefFor({ frame: 'discover', page: 'explore' })],
  // Contact (an upstream request) is dropped with contributions: the account home.
  ['/projects', '?surface=contact', `${hrefFor({ frame: 'account', place: 'projects' })}?surface=contact`],
];
// Addresses that are already the new ones, or keep their shape, or keep their old screen.
const unchanged = [
  ['/', ''],
  [base, ''],
  [`${base}/lanes`, ''],
  [`${base}/lanes/${LANE}`, ''],
  [`${base}/code/src/a.ts`, ''],
  [`${base}/settings`, ''],
  // The code place keeps its address; the rebuilt Code ignores a map view.
  [`${base}/code`, '?view=map'],
  ['/', '?surface=contact'],
  [`${ROOT}/account`, ''],
  [`${ROOT}/mara/tide-pool/plan`, ''],
  ['/explore', ''],
  ['/device', ''],
  ['/approve', '?project=x&lane=y'],
  ['/assets/app.js', ''],
  ['/local/demo/intents', ''],
  ['/settings/extra/path/here', ''],
];

for (const [pathname, search, to] of paths)
  test(`old ${pathname}${search} opens ${to} with no read`, () => {
    assert.deepEqual(oldAddress(pathname, search), { kind: 'go', to });
    assert.ok(isAppPath(to), 'the target is in the rebuilt app');
  });

// These keep their shape: under "/-" the old screen's address opens the rebuilt one, and after the switch it is the same.
for (const section of ['you', 'checks', 'secrets', 'agents', 'project'])
  test(`old settings/${section} opens the rebuilt page, and is not a redirect once the root is empty`, () => {
    const go = oldAddress(`${base}/settings/${section}`, '');
    assert.deepEqual(go, ROOT ? { kind: 'go', to: project('settings', section) } : null);
  });

for (const [pathname, search] of unchanged)
  test(`${pathname}${search} is not redirected`, () => {
    assert.equal(oldAddress(pathname, search), null);
  });

test('an old address never redirects to itself, and a redirect never lands on another old address', () => {
  for (const [pathname, search] of paths) {
    const go = oldAddress(pathname, search);
    assert.notEqual(go.to, pathname + search);
    assert.equal(oldAddress(new URL(go.to, 'https://x.test').pathname, ''), null, go.to);
  }
  // Every handle the old paths reserve stays out of the project rows.
  for (const handle of reservedHandles) assert.equal(oldAddress(`/${handle}/x/activity`, ''), null, handle);
});

test('a decision or review id is looked up in its project: path form', () => {
  const ref = { handle: 'mara', slug: 'tide-pool' };
  assert.deepEqual(oldAddress(`${base}/decisions/${short('d', LANE)}`, ''), {
    kind: 'look',
    ref,
    find: { kind: 'decision', id: LANE },
    dest: { place: 'needs', section: '', rest: '' },
  });
  assert.deepEqual(oldAddress(`${base}/review/${short('v', LANE)}`, ''), {
    kind: 'look',
    ref,
    find: { kind: 'review', id: LANE },
    dest: { place: 'needs', section: '', rest: '' },
  });
  // A review has no list page.
  assert.equal(oldAddress(`${base}/review`, ''), null);
});

// [search of an old `?project=<id>` link, where it opens inside the project]
const queries = [
  ['', project('needs')],
  [`&lane=${LANE}&tab=intents`, project('lanes', '', LANE)],
  [`&projectTab=lanes&lane=${LANE}`, project('lanes', '', LANE)],
  [`&lane=${LANE}`, project('lanes', '', LANE)],
  ['&projectTab=lanes', project('lanes')],
  ['&projectTab=planning', project('plan')],
  [`&projectTab=intent&intent=${LANE}&tab=intents`, project('plan', '', LANE)],
  ['&projectTab=planning&planningItem=abcd1234', project('plan', '', 'abcd1234')],
  ['&projectTab=views&viewId=v1', project('plan')],
  ['&projectTab=decisions', project('plan')],
  ['&projectTab=coordination', project('needs', 'held')],
  ['&projectTab=activity&activity=1', project('needs', 'held')],
  ['&projectTab=delivery', project('code')],
  ['&tab=code&file=src/a%20b.ts', project('code', 'files', 'src/a b.ts')],
  [
    `&projectTab=delivery&file=README.md&head=${'b'.repeat(64)}`,
    `${project('code', 'files', 'README.md')}?at=${'b'.repeat(64)}`,
  ],
  // A pin that is not a State is not kept.
  ['&projectTab=delivery&file=README.md&head=save', project('code', 'files', 'README.md')],
  ['&projectTab=checks', project('settings', 'checks')],
  ['&projectTab=sharing&settingsSection=access', project('settings')],
  ['&projectTab=settings&settingsSection=you', project('settings', 'you')],
  // Settings pages whose screen has landed, and the dropped ones (Item f2ee8381).
  ['&projectTab=general', project('settings', 'project')],
  ['&projectTab=transfer', project('settings', 'project')],
  ['&projectTab=agents', project('settings', 'agents')],
  ['&projectTab=contributions', project('lanes')],
  ['&view=map', project('code')],
  [`&file=src/a.ts&view=map`, project('code')],
];
for (const [search, to] of queries)
  for (const entry of ['/', '/projects'])
    test(`old ${entry}?project=<id>${search} resolves the project, then opens ${to}`, () => {
      const look = oldAddress(entry, `?project=abc123${search}`);
      assert.deepEqual(look.ref, { projectId: 'abc123' });
      assert.equal(look.kind, 'look');
      assert.equal(look.find, undefined);
      assert.equal(lookHref(look, { handle: 'mara', slug: 'tide-pool', to: null }), to);
    });

test('a ?project= link to a decision or a review is looked up, and the server answer wins', () => {
  const review = oldAddress('/projects', `?project=abc123&projectTab=intent&reviewView=${LANE}`);
  assert.deepEqual(review.find, { kind: 'review', id: LANE });
  const decision = oldAddress('/', `?project=abc123&projectTab=decisions&decision=${short('d', LANE)}`);
  assert.deepEqual(decision.find, { kind: 'decision', id: LANE });
  const found = { handle: 'mara', slug: 'tide-pool' };
  assert.equal(lookHref(review, { ...found, to: { place: 'lanes', id: LANE } }), project('lanes', '', LANE));
  assert.equal(lookHref(decision, { ...found, to: { place: 'plan', id: LANE } }), project('plan', '', LANE));
  // Nothing found for the id: the project's own page, never an error that names the id.
  assert.equal(lookHref(decision, { ...found, to: null }), project('plan'));
  assert.equal(lookHref(review, { ...found, to: null }), project('needs'));
});

test('a redirect target parses as the page it names in the rebuilt app', () => {
  for (const [pathname, search] of paths) {
    const { to } = oldAddress(pathname, search);
    const route = parseAppPath(new URL(to, 'https://x.test').pathname);
    assert.notEqual(route.frame, 'missing', to);
  }
});

test('an old settings page named by ?settingsSection= follows that page, as the old screen did', () => {
  // The path says Checks, the query says Transfer: the old screen opened Transfer, now Settings > Project.
  assert.equal(
    oldAddress(`${base}/settings/checks`, '?settingsSection=transfer').to,
    project('settings', 'project'),
  );
});

test('sign-in refuses a path that normalizes to another origin', () => {
  for (const bad of [
    '/.//evil.example/projects?project=x',
    '/./\\/evil.example/projects?project=x',
    '/a/..//evil.example',
  ])
    assert.equal(safeNext(bad), `${ROOT}/account`, bad);
});

test('sign-in returns an old id-only link unchanged, and still refuses addresses outside the app', () => {
  const link = `/projects?project=abc123&lane=${LANE}`;
  assert.equal(safeNext(link), link);
  assert.equal(
    safeNext(`/mara/tide-pool/decisions/${short('d', LANE)}`),
    `/mara/tide-pool/decisions/${short('d', LANE)}`,
  );
  // An old plain path is same-origin and redirects after sign-in (main.tsx); the earlier /- form and static pages are not.
  assert.equal(safeNext('/projects'), '/projects');
  for (const bad of [
    '/-/account',
    '/docs/',
    '//evil.example/projects?project=x',
    'https://evil.example/projects?project=x',
  ])
    assert.equal(safeNext(bad), `${ROOT}/account`, bad);
});
