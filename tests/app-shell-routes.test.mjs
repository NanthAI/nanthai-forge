// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The rebuilt app's addresses and navigation (Item 84125787): stable deep links, browser Back, keys that never fire
// in a field, sign-in that only returns into the app, every supported destination still reachable, and the first
// passkey's wire shape matching what the server accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';

const paths = await import(moduleUrl('../web/src/app/paths.ts'));
const { safeNext } = await import(moduleUrl('../web/src/app/session.ts'));
const { assertPasskey, createPasskey, toBase64url } = await import(moduleUrl('../web/src/app/webauthn.ts'));
const { ROOT, hrefFor, parseAppPath, projectPlaces, placeSections, accountPlaces } = paths;
const { reservedHandles } = await import(moduleUrl('../src/readable-urls.ts'));

const project = (place, section = '', rest = '') => ({
  frame: 'project',
  handle: 'mara',
  project: 'tide-pool',
  place,
  section,
  rest,
});
const everyRoute = [
  { frame: 'public', page: 'signin' },
  { frame: 'public', page: 'passkey' },
  { frame: 'public', page: 'device' },
  { frame: 'bare', page: 'new' },
  { frame: 'bare', page: 'import' },
  { frame: 'discover', page: 'explore' },
  { frame: 'discover', page: 'profile', handle: 'mara' },
  ...accountPlaces.map(place => ({ frame: 'account', place })),
  ...projectPlaces.flatMap(place => placeSections[place].map(section => project(place, section))),
  project('lanes', '', 'l-AbCdEfGhIjKlMnOpQrStUv'),
  project('plan', '', 'i-AbCdEfGhIjKlMnOpQrStUv'),
  project('code', 'files', 'src/a b/ünï.ts'),
  project('code', '', '0f8d2c1e-5b7a-4c3d-9e21-6a4b8f0c7d35'),
  // One main red's view, the address a Main broke row's Why opens (ae068e0c).
  project('code', '', 'red/1234'),
  { frame: 'project', handle: 'a-b', project: 'x~y', place: 'settings', section: 'you', rest: '' },
];

test('every frame address parses back to the same place (stable deep links)', () => {
  for (const route of everyRoute) {
    const href = hrefFor(route);
    assert(href.startsWith(`${ROOT}/`) || href === ROOT, href);
    assert.deepEqual(parseAppPath(new URL(href, 'https://forge.invalid').pathname), route, href);
  }
  assert.equal(hrefFor(project('needs')), `${ROOT}/mara/tide-pool`, 'Needs me is the project front page');
});

test('a project discovery link survives sign-in while the ordinary signed-in address opens Needs me', () => {
  const href = paths.publicProjectHref('mara', 'tide-pool');
  assert.equal(safeNext(href), href);
  const url = new URL(href, 'https://forge.invalid');
  const route = parseAppPath(url.pathname);
  assert.equal(paths.isPublicProjectView(route, true, url.searchParams.get('view')), true);
  assert.equal(paths.isPublicProjectView(route, true, null), false);
  assert.equal(paths.isPublicProjectView(route, false, null), true);
  assert.equal(paths.isPublicProjectView(project('settings'), true, 'public'), false);
});

test('b0704959: the app is served at the root; the public page, docs, files and the earlier /- addresses are not app pages', () => {
  assert.equal(ROOT, '');
  assert.equal(paths.isAppPath('/mara/tide-pool'), true, 'the project page is the address bindings store');
  for (const path of [
    '/',
    '/docs',
    '/docs/',
    '/docs/status/',
    '/llms.txt',
    '/assets/app.js',
    '/-',
    '/-/mara',
  ])
    assert.equal(paths.isAppPath(path), false, path);
  for (const path of [
    `${ROOT}/mara/tide-pool/nope`,
    `${ROOT}/mara/tide-pool/stats/extra`,
    `${ROOT}/account/billing/x`,
    `${ROOT}/explore/x`,
    '/-/mara/tide-pool',
  ])
    assert.equal(parseAppPath(path).frame, 'missing', path);
  // A handle alone is that person's or organisation's public profile (Item 8947a779).
  assert.deepEqual(parseAppPath(`${ROOT}/mara`), { frame: 'discover', page: 'profile', handle: 'mara' });
});

test('b0704959: a reserved first segment never reads as a handle, and every app place is reserved', () => {
  for (const path of ['/projects', '/settings', '/local/demo', '/api/x', '/import', '/agents/a/b'])
    assert.equal(parseAppPath(path).frame, 'missing', path);
  for (const route of everyRoute.filter(route => route.frame !== 'project' && route.page !== 'profile')) {
    const first = hrefFor(route).split('/')[1];
    assert(reservedHandles.has(first), `${first} (${hrefFor(route)}) must be a reserved handle`);
  }
  for (const page of ['approve', 'terms', 'privacy']) assert(reservedHandles.has(page), page);
  // paths.ts keeps its own copy of the reserved names: none of them may read as a handle, nor one more.
  const copy = /const reserved = new Set\(\[([^\]]+)\]\)/.exec(
    readFileSync(new URL('../web/src/app/paths.ts', import.meta.url), 'utf8'),
  );
  assert.deepEqual(new Set([...copy[1].matchAll(/'([^']+)'/g)].map(match => match[1])), reservedHandles);
  for (const name of [
    ...reservedHandles,
    ...[...reservedHandles].map(name => name.toUpperCase()),
    'Account',
    '-',
  ]) {
    assert.notEqual(parseAppPath(`/${name}`).page, 'profile', name);
    assert.notEqual(parseAppPath(`/${name}/x`).frame, 'project', name);
  }
});

test('sign-in returns only to an address inside the rebuilt app', () => {
  assert.equal(
    safeNext(`${ROOT}/mara/tide-pool/lanes?stop=checking`),
    `${ROOT}/mara/tide-pool/lanes?stop=checking`,
  );
  assert.equal(safeNext(`${ROOT}/device?code=ABCDE-FGHJK`), `${ROOT}/device?code=ABCDE-FGHJK`);
  for (const bad of [
    'https://evil.example/account',
    '//evil.example/account',
    '/docs/',
    `${ROOT}/signin?next=x`,
    '/SIGNIN',
    '/SignIn/passkey',
    '/DOCS/',
    '/\\evil.example/account',
    'javascript:alert(1)',
    null,
  ])
    assert.equal(safeNext(bad), `${ROOT}/account`, String(bad));
});

test('de67c77d: the existing-account passkey link and its way back keep a device approval return address', () => {
  const device = `${ROOT}/device?request=synthetic-request`;
  const link = new URL(paths.signInHref(device, true), 'https://forge.example');
  assert.equal(link.pathname, `${ROOT}/signin`);
  assert.equal(link.searchParams.get('link'), 'existing');
  assert.equal(safeNext(link.searchParams.get('next')), device);
  // After the passkey is added, "Continue with your passkey" opens the plain sign-in with the same return.
  const back = new URL(paths.signInHref(safeNext(link.searchParams.get('next'))), 'https://forge.example');
  assert.equal(back.searchParams.get('link'), null);
  assert.equal(safeNext(back.searchParams.get('next')), device);
  assert.equal(paths.signInHref(), `${ROOT}/signin`);
});

test('frame keys never fire while typing in a field; ⌘K and Ctrl+K always open go to or run', async () => {
  const { keyAction } = await import(moduleUrl('../web/src/app/router.ts'));
  const press = (key, extra = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });
  const field = { closest: selector => (selector.includes('input') ? {} : null) };
  const page = { closest: () => null };
  assert.equal(keyAction(press('3'), field, true), null);
  assert.equal(keyAction(press('?'), field, true), null);
  assert.equal(keyAction(press('k', { metaKey: true }), field, true), 'palette');
  assert.equal(keyAction(press('K', { ctrlKey: true }), page, false), 'palette');
  assert.deepEqual(keyAction(press('3'), page, true), { place: 2 });
  assert.equal(keyAction(press('3'), page, false), null, 'number keys belong to the project frame only');
  assert.equal(keyAction(press('3', { altKey: true }), page, true), null);
  assert.equal(keyAction(press('?', { shiftKey: true }), page, false), 'keys');
  assert.equal(keyAction(press('['), page, false, true), 'rail');
  assert.equal(keyAction(press('['), field, true, true), null);
  assert.equal(keyAction(press('['), page, true), null);
  assert.equal(keyAction(press('[', { ctrlKey: true }), page, true, true), null);
  assert.equal(keyAction(press('[', { shiftKey: true }), page, true, true), null);
  assert.equal(keyAction(press('['), page, true, true), 'rail');
});

test('browser Back walks the same entries as in-app moves, and modified clicks keep the browser behaviour', async () => {
  const entries = [`${ROOT}/mara/tide-pool`];
  let index = 0;
  const listeners = new Map();
  const assigned = [];
  const location = {
    get href() {
      return `https://forge.invalid${entries[index]}`;
    },
    get pathname() {
      return new URL(this.href).pathname;
    },
    get search() {
      return new URL(this.href).search;
    },
    get hash() {
      return '';
    },
    origin: 'https://forge.invalid',
    assign: href => assigned.push(href),
  };
  const history = {
    pushState: (_s, _u, url) => (entries.splice(index + 1), entries.push(url), index++),
    replaceState: (_s, _u, url) => (entries[index] = url),
    back: () => (index--, listeners.get('popstate')?.()),
  };
  Object.assign(globalThis, {
    location,
    history,
    scrollTo: () => undefined,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  });
  globalThis.document ??= { getElementById: () => null };
  const router = await import(moduleUrl('../web/src/app/router.ts'));
  router.navigate(`${ROOT}/mara/tide-pool/lanes`);
  router.navigate(`${ROOT}/mara/tide-pool/plan`, { replace: true });
  assert.deepEqual(
    entries,
    [`${ROOT}/mara/tide-pool`, `${ROOT}/mara/tide-pool/plan`],
    'replace adds no entry',
  );
  history.back();
  assert.equal(location.pathname, `${ROOT}/mara/tide-pool`);
  router.navigate('/mara/tide-pool/settings/access');
  assert.deepEqual(
    assigned,
    ['https://forge.invalid/mara/tide-pool/settings/access'],
    'an old screen loads as a page',
  );
  let prevented = false;
  const anchor = { href: `https://forge.invalid${ROOT}/account`, target: '' };
  router.followLink({
    defaultPrevented: false,
    button: 0,
    metaKey: true,
    currentTarget: anchor,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, false, '⌘-click opens a new tab as the browser does');
  router.followLink({
    defaultPrevented: false,
    button: 0,
    currentTarget: anchor,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  assert.equal(location.pathname, `${ROOT}/account`);
});

test('the first passkey sends exactly the wire fields the server accepts, and a closed prompt is an answer', async () => {
  const bytes = text => new TextEncoder().encode(text).buffer;
  globalThis.PublicKeyCredential ??= class {};
  const options = {
    rp: { id: 'forge.invalid', name: 'Forge' },
    user: { id: toBase64url(bytes('user')), name: 'mara', displayName: 'mara' },
    challenge: toBase64url(bytes('challenge')),
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    timeout: 1000,
    excludeCredentials: [],
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    extensions: {},
  };
  let asked;
  const made = await createPasskey(options, {
    create: async request => {
      asked = request.publicKey;
      return {
        id: 'cred',
        rawId: bytes('raw'),
        getClientExtensionResults: () => ({ credProps: { rk: true } }),
        response: {
          clientDataJSON: bytes('client'),
          attestationObject: bytes('att'),
          getTransports: () => ['internal'],
          getPublicKey: () => bytes('pk'),
        },
      };
    },
  });
  assert.equal(new TextDecoder().decode(asked.challenge), 'challenge');
  assert.deepEqual(made, {
    ok: true,
    wire: {
      id: 'cred',
      rawId: toBase64url(bytes('raw')),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64url(bytes('client')),
        attestationObject: toBase64url(bytes('att')),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    },
  });
  const closed = await createPasskey(options, {
    create: async () => Promise.reject(new DOMException('closed', 'NotAllowedError')),
  });
  assert.deepEqual(closed, { ok: false, failure: 'closed' });
});

test('link confirmation sends the browser assertion in the server wire contract and handles a closed prompt', async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const options = {
    challenge: toBase64url(bytes),
    timeout: 1000,
    rpId: 'forge.example',
    allowCredentials: [{ id: toBase64url(bytes), type: 'public-key' }],
    userVerification: 'required',
  };
  const response = await assertPasskey(options, {
    get: async ({ publicKey }) => {
      assert.deepEqual(new Uint8Array(publicKey.challenge), new Uint8Array(bytes));
      assert.equal(publicKey.userVerification, 'required');
      return {
        id: 'credential',
        rawId: bytes,
        response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes, userHandle: bytes },
      };
    },
  });
  assert.deepEqual(response, {
    id: 'credential',
    rawId: 'AQID',
    type: 'public-key',
    response: { clientDataJSON: 'AQID', authenticatorData: 'AQID', signature: 'AQID', userHandle: 'AQID' },
    clientExtensionResults: {},
  });
  await assert.rejects(assertPasskey(options, { get: async () => null }), /confirmation closed/);
});
