// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const code = await import(moduleUrl('../web/src/device/code.ts'));

test('device codes are paste-tolerant and grouped like the terminal prints them', () => {
  assert.equal(code.formatCode(' qk7pm 2xdht\n'), 'QK7PM-2XDHT');
  assert.equal(code.formatCode('QK7PM-2XDHT-EXTRA'), 'QK7PM-2XDHT');
  assert.equal(code.formatCode('qk7'), 'QK7');
  assert.equal(code.codeComplete('QK7PM2XDHT'), true);
  assert.equal(code.codeComplete('QK7PM-2XD'), false);
  assert.equal(code.codeProblem('AUTH_EXPIRED'), 'expired');
  assert.equal(code.codeProblem('AUTH_CODE_USED'), 'used');
  assert.equal(code.codeProblem('AUTH_SLOW_DOWN'), null);
  assert.equal(code.codeProblem(undefined), null);
  assert.equal(code.expiresIn(Date.now() + 8 * 60_000, Date.now()), 'in 8 min');
});

test('a terminal-chosen name is cleaned and capped before it is shown (S-02)', () => {
  const name = 'Forge\u202Eevil\u200B  \n' + 'x'.repeat(100) + '<b>hi</b>';
  const shown = code.shownDeviceName(name);
  assert.ok([...shown].length <= code.SHOWN_NAME_MAX);
  assert.doesNotMatch(shown, /[\u202E\u200B\n]/);
  assert.equal(code.shownDeviceName('  \u202E '), 'unnamed');
});

test('W8/W22: the device page classifies a refusal by its server code, never by its words', async () => {
  const { ConvexError } = await import('convex/values');
  const { hostedErrorCode } = await import(moduleUrl('../web/src/snapshot.ts'));
  const refused = (code, message) => new ConvexError({ code, message });
  assert.equal(hostedErrorCode(refused('AUTH_EXPIRED', 'x')), 'AUTH_EXPIRED');
  assert.equal(hostedErrorCode(new Error('AUTH_EXPIRED')), undefined, 'a plain Error has no code');
  assert.equal(hostedErrorCode(new ConvexError('text')), undefined);
  // A service error whose text happens to say "unavailable" is not an expired code (old regex: expired).
  const outage = refused('SERVICE_UNAVAILABLE', 'The device service is unavailable.');
  assert.equal(code.codeProblem(hostedErrorCode(outage)), null);
  // A reworded expiry message is still an expired code.
  assert.equal(code.codeProblem(hostedErrorCode(refused('AUTH_EXPIRED', 'Please start over.'))), 'expired');
  assert.equal(code.codeProblem(hostedErrorCode(refused('AUTH_CODE_USED', 'Taken.'))), 'used');
});

// B-02: the /device page keeps every rule of the earlier /device page (docs/security.md, "CLI device credentials").
const { DeviceView } = await import(moduleUrl('../web/src/app/Device.tsx'));
const linkCode = await import(moduleUrl('../web/src/device/link-code.ts'));
const hostileName = 'Forge‮evil​  \n' + 'x'.repeat(100) + '<b>hi</b>';
const pending = (extra = {}) => ({
  name: hostileName,
  scope: 'cli',
  expiresAt: Date.now() + 60_000,
  state: 'pending',
  ...extra,
});
const renderNew = (phase, extra = {}) =>
  renderToStaticMarkup(
    h(DeviceView, {
      phase,
      code: 'QK7PM2XDHT',
      setCode() {},
      typed: '',
      setTyped() {},
      requireTyped: false,
      busy: false,
      problem: null,
      viewerHandle: 'mara',
      now: Date.now(),
      submit() {},
      decide() {},
      restart() {},
      ...extra,
    }),
  );
const pages = { device: renderNew };
const approveButton = html => /<button[^>]*>Approve<\/button>/.exec(html)?.[0] ?? '';
const denyButton = html => /<button[^>]*>Deny<\/button>/.exec(html)?.[0] ?? '';

test('B-02: the approval page shows the terminal-chosen name last, quoted, cleaned, capped and marked not verified', () => {
  const shown = code.shownDeviceName(hostileName);
  for (const [page, draw] of Object.entries(pages)) {
    const review = draw({ kind: 'review', request: pending() });
    const rows = [...review.matchAll(/<dt>([^<]*)<\/dt>/g)].map(match => match[1]);
    assert.equal(rows.at(-1), 'Name', `${page}: the name comes after every server-known fact`);
    assert.match(review, /data-untrusted="true"/, page);
    assert.match(review, /chosen by the terminal, not verified/, page);
    assert.ok(
      review.includes(`<q translate="no">${shown.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</q>`),
      page,
    );
    assert.doesNotMatch(review, /[‮​]/, `${page}: direction and invisible characters are removed`);
    assert.doesNotMatch(review, /x{40}/, `${page}: the name is capped`);
    assert.doesNotMatch(review, /<b>hi/, `${page}: markup in the name is escaped`);
    const done = draw({ kind: 'done', approved: true, name: hostileName });
    assert.doesNotMatch(done, /<h1>[^<]*(Forge|evil|x{5})/, `${page}: the name is never a heading`);
    assert.match(done, /<q translate="no">Forge evil x/, page);
  }
});

test('B-02: a code from a link is never shown, and Approve unlocks only once it is typed; Deny is never gated', () => {
  for (const [page, draw] of Object.entries(pages)) {
    for (const kind of ['enter', 'checking']) {
      const arriving = draw({ kind }, { requireTyped: true });
      assert.doesNotMatch(arriving, /QK7PM/, `${page} ${kind}: the link's code is not on the page`);
    }
    const fromLink = draw({ kind: 'review', request: pending() }, { requireTyped: true, typed: 'QK7PM' });
    assert.doesNotMatch(
      fromLink.replace(/value="[^"]*"/g, ''),
      /QK7PM/,
      `${page}: only the person's own typing shows`,
    );
    assert.match(approveButton(fromLink), /disabled/, page);
    assert.doesNotMatch(denyButton(fromLink), /disabled/, `${page}: Deny is never gated`);
    const typed = draw({ kind: 'review', request: pending() }, { requireTyped: true, typed: 'qk7pm 2xdht' });
    assert.doesNotMatch(approveButton(typed), /disabled/, page);
    const byHand = draw({ kind: 'review', request: pending() });
    assert.doesNotMatch(
      approveButton(byHand),
      /disabled/,
      `${page}: a code typed by hand needs no second typing`,
    );
  }
});

test('B-02: a decided code says what was decided and a lapsed code offers no answer', () => {
  for (const [page, draw] of Object.entries(pages)) {
    const approved = draw({ kind: 'review', request: pending({ state: 'approved' }) });
    assert.match(approved, /already approved/, page);
    assert.doesNotMatch(approved, />Approve<|>Deny</, page);
    assert.match(draw({ kind: 'review', request: pending({ state: 'denied' }) }), /was denied/, page);
    const lapsed = draw({ kind: 'review', request: pending({ expiresAt: Date.now() - 1000 }) });
    assert.match(lapsed, /This code has expired/, page);
    assert.doesNotMatch(lapsed, />Approve<|>Deny</, page);
  }
});

test('B-02: a code in a link leaves the address on arrival and is kept only in this tab, for the life of a code', () => {
  const kept = new Map();
  const browser = {
    location: { href: 'https://forge.example/device?code=qk7pm-2xdht&from=cli#top' },
    history: {
      state: null,
      replaceState(_state, _unused, url) {
        browser.location.href = new URL(url, browser.location.href).href;
      },
    },
    sessionStorage: {
      getItem: key => kept.get(key) ?? null,
      setItem: (key, value) => kept.set(key, String(value)),
      removeItem: key => kept.delete(key),
    },
  };
  const saved = Object.fromEntries(
    Object.keys(browser).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const [name, value] of Object.entries(browser))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    const now = Date.now();
    assert.equal(linkCode.takeLinkCode(now), 'QK7PM-2XDHT');
    assert.equal(browser.location.href, 'https://forge.example/device?from=cli#top', 'only the code leaves');
    assert.doesNotMatch(JSON.stringify(browser.location), /QK7PM/i);
    // The sign-in round trip returns to the bare address; the code comes back from this tab.
    browser.location.href = 'https://forge.example/device';
    assert.equal(linkCode.takeLinkCode(now + 60_000), 'QK7PM-2XDHT');
    assert.equal(linkCode.takeLinkCode(now + 600_000), '', 'a code is never kept past its 10 minutes');
    browser.location.href = 'https://forge.example/device?code=QK7PM2XDHT';
    assert.equal(linkCode.takeLinkCode(now), 'QK7PM-2XDHT');
    assert.equal(browser.location.href, 'https://forge.example/device');
    linkCode.forgetLinkCode();
    assert.equal(linkCode.takeLinkCode(now), '', 'an answered code is not offered again');
    browser.location.href = 'https://forge.example/device?code=QK7';
    assert.equal(linkCode.takeLinkCode(now), 'QK7', 'a partial code fills the field and is not kept');
    assert.equal(kept.size, 0);
  } finally {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  }
});

test("the link the CLI prints opens the app's Device page, and an earlier /-/device link follows it (ac85b100, b0704959)", async () => {
  const { readFileSync } = await import('node:fs');
  const { earlierAppPath, isAppPath, parseAppPath } = await import(moduleUrl('../web/src/app/paths.ts'));
  const source = readFileSync(new URL('../convex/deviceActions.ts', import.meta.url), 'utf8');
  const links = [...source.matchAll(/new URL\('([^']+)', web\)/g)].map(match => match[1]);
  assert.deepEqual(links, ['/device'], 'one approval link, to a page the app serves');
  assert.ok(isAppPath(links[0]) && parseAppPath(links[0]).page === 'device');
  // A code printed before the switch to the root is valid for ten minutes and still points at /-/device.
  for (const earlier of ['/-/device', '//-/device'])
    assert.equal(earlierAppPath(earlier), '/device', earlier);
  assert.equal(earlierAppPath('/device'), null);
  assert.equal(earlierAppPath('/-device'), null);
});

test('df06081d: the GitHub check keeps the typed terminal code through its redirect, and hides its button without a linked GitHub identity', () => {
  const kept = new Map();
  const browser = {
    location: { href: 'https://forge.example/device?code=QK7PM2XDHT', origin: 'https://forge.example' },
    history: {
      state: null,
      replaceState(_s, _u, url) {
        browser.location.href = new URL(url, browser.location.href).href;
      },
    },
    sessionStorage: {
      getItem: key => kept.get(key) ?? null,
      setItem: (key, value) => kept.set(key, String(value)),
      removeItem: key => kept.delete(key),
    },
  };
  const saved = Object.fromEntries(
    Object.keys(browser).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const [name, value] of Object.entries(browser))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  // The page reads the link code first, then the typed code (web/src/app/Device.tsx order).
  const arrive = (href, now) => {
    browser.location.href = href;
    const code = linkCode.takeLinkCode(now);
    const requestId = new URL(href).searchParams.get('request') ?? '';
    return { code, typed: linkCode.takeTypedCode({ requestId, code }, now) };
  };
  try {
    const now = Date.UTC(2026, 10, 10, 12);
    // A link code: the person types it again, leaves for GitHub and comes back with it still typed.
    assert.deepEqual(arrive('https://forge.example/device?code=QK7PM2XDHT', now), {
      code: 'QK7PM-2XDHT',
      typed: '',
    });
    let back = linkCode.githubReturn(
      { code: 'QK7PM-2XDHT', typed: 'QK7PM-2XDHT', fromLink: true, requestId: '' },
      now,
    );
    assert.equal(back, 'https://forge.example/device');
    assert.deepEqual(arrive(back, now + 60_000), { code: 'QK7PM-2XDHT', typed: 'QK7PM-2XDHT' });
    linkCode.forgetLinkCode();
    // A request link (remembered device): the request id comes back in the address and the typed code from this tab.
    back = linkCode.githubReturn(
      { code: '', typed: 'AB3CD-EF4GH', fromLink: false, requestId: 'req-1' },
      now,
    );
    assert.equal(back, 'https://forge.example/device?request=req-1');
    assert.deepEqual(
      arrive('https://forge.example/device?request=req-2', now + 60_000),
      { code: '', typed: '' },
      'another request never inherits it',
    );
    assert.equal(kept.size, 0, 'a typed code for another request is forgotten');
    back = linkCode.githubReturn(
      { code: '', typed: 'AB3CD-EF4GH', fromLink: false, requestId: 'req-1' },
      now,
    );
    assert.deepEqual(arrive(back, now + 60_000), { code: '', typed: 'AB3CD-EF4GH' });
    linkCode.forgetLinkCode();
    // A code typed into the first field comes back like a link code, already typed.
    back = linkCode.githubReturn({ code: 'QK7PM-2XDHT', typed: '', fromLink: false, requestId: '' }, now);
    assert.deepEqual(arrive(back, now + 60_000), { code: 'QK7PM-2XDHT', typed: 'QK7PM-2XDHT' });
    assert.deepEqual(
      arrive(back, now + 600_000),
      { code: '', typed: '' },
      "never kept past a code's 10 minutes",
    );
    assert.equal(kept.size, 0, 'an expired typed code is removed, not left in the tab');
    linkCode.githubReturn({ code: 'QK7PM-2XDHT', typed: '', fromLink: false, requestId: '' }, now);
    linkCode.forgetLinkCode();
    assert.equal(kept.size, 0, 'an answer forgets both');
  } finally {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  }
  const review = github =>
    renderNew(
      {
        kind: 'review',
        request: pending({ needsConfirmation: true, ...(github === undefined ? {} : { github }) }),
      },
      { confirmPasskey() {}, confirmGithub() {} },
    );
  assert.doesNotMatch(review(false), /Check with GitHub/);
  assert.match(review(false), /Check with passkey/);
  assert.match(review(true), /Check with GitHub/);
  assert.match(review(undefined), /Check with GitHub/, 'an older server without the field keeps the button');
});
