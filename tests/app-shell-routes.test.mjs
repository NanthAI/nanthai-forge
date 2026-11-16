// SPDX-License-Identifier: Apache-2.0
// The rebuilt app's addresses and navigation (Item 84125787): stable deep links, browser Back, keys that never fire
// in a field, sign-in that only returns into the app, every supported destination still reachable, and the first
// passkey's wire shape matching what the server accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const paths = await import(moduleUrl('../web/src/app/paths.ts'));
const { safeNext } = await import(moduleUrl('../web/src/app/session.ts'));
const { createPasskey, toBase64url } = await import(moduleUrl('../web/src/app/webauthn.ts'));
const { ROOT, hrefFor, parseAppPath, currentScreenHref, projectPlaces, placeSections, accountPlaces } = paths;

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
  ...accountPlaces.map(place => ({ frame: 'account', place })),
  ...projectPlaces.flatMap(place => placeSections[place].map(section => project(place, section))),
  project('lanes', '', 'l-AbCdEfGhIjKlMnOpQrStUv'),
  project('plan', '', 'i-AbCdEfGhIjKlMnOpQrStUv'),
  project('code', '', 'src/a b/ünï.ts'),
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

test('addresses outside the rebuilt app or with unknown places are not app pages', () => {
  assert.equal(paths.isAppPath('/mara/tide-pool'), false);
  assert.equal(paths.isAppPath('/-x/a'), false);
  for (const path of [
    `${ROOT}/mara/tide-pool/nope`,
    `${ROOT}/mara/tide-pool/stats/extra`,
    `${ROOT}/account/billing/x`,
    `${ROOT}/mara`,
  ])
    assert.equal(parseAppPath(path).frame, 'missing', path);
});

test('old supported destinations stay reachable from every place until stage C replaces them', () => {
  const missing = [];
  for (const route of everyRoute.filter(route => route.frame === 'project' || route.frame === 'account')) {
    const href = currentScreenHref(route);
    if (href === null) missing.push(route.frame === 'project' ? route.place : route.place);
    else assert(!paths.isAppPath(href), `${href} must be an old screen, not a rebuilt one`);
  }
  assert.deepEqual(
    [...new Set(missing)].sort(),
    ['billing', 'stats'],
    'only places with no old screen lack one',
  );
});

test('sign-in returns only to an address inside the rebuilt app', () => {
  assert.equal(
    safeNext(`${ROOT}/mara/tide-pool/lanes?stop=checking`),
    `${ROOT}/mara/tide-pool/lanes?stop=checking`,
  );
  assert.equal(safeNext(`${ROOT}/device?code=ABCDE-FGHJK`), `${ROOT}/device?code=ABCDE-FGHJK`);
  for (const bad of [
    'https://evil.example/-/account',
    '//evil.example/-/account',
    '/mara/tide-pool',
    `${ROOT}/signin?next=x`,
    'javascript:alert(1)',
    null,
  ])
    assert.equal(safeNext(bad), `${ROOT}/account`, String(bad));
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
