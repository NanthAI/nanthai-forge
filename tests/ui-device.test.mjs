// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const code = await import(moduleUrl('../web/src/device/code.ts'));
const { DeviceApproval } = await import(moduleUrl('../web/src/device/DeviceApproval.tsx'));
const { DeviceListView } = await import(moduleUrl('../web/src/device/DeviceList.tsx'));

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

const render = (phase, extra = {}) =>
  renderToStaticMarkup(
    h(DeviceApproval, {
      phase,
      code: 'QK7PM2XDHT',
      setCode() {},
      find() {},
      decide() {},
      restart() {},
      signIn: h('button', null, 'Sign in to approve'),
      now: Date.now(),
      ...extra,
    }),
  );

test('every device state says what to do next, in plain words', () => {
  assert.match(render({ kind: 'signed-out' }), /Sign in to approve[\s\S]*/);
  assert.match(render({ kind: 'signed-out' }), /QK7PM-2XDHT/);
  const review = render({
    kind: 'review',
    request: { name: 'dino-mbp', scope: 'cli', expiresAt: Date.now() + 60_000, state: 'pending' },
  });
  assert.match(review, />Approve</);
  assert.match(review, />Deny</);
  assert.match(review, /30 days, or until you revoke it/);
  assert.doesNotMatch(review, /\bIP\b|location/, 'no facts we do not have');
  assert.match(render({ kind: 'approved', name: 'dino-mbp' }), /return to your terminal/);
  assert.doesNotMatch(render({ kind: 'problem', problem: 'expired' }), /This code has expired/);
  const failure = render({ kind: 'enter' }, { error: 'Offline' });
  assert.match(failure, /aria-invalid="true"/);
  assert.doesNotMatch(failure, />Offline<|role="alert"/);
});

test('revoking a device takes a second click, and old devices fold away', () => {
  const now = Date.now();
  const html = renderToStaticMarkup(
    h(DeviceListView, {
      now,
      revoke: async () => undefined,
      rows: [
        { id: '1', credentialId: 'a', name: 'dino-mbp', scope: 'cli', expiresAt: now + 1e9, revoked: false },
        { id: '2', credentialId: 'b', name: 'old', scope: 'cli', expiresAt: now + 1e9, revoked: true },
      ],
    }),
  );
  assert.match(html, /dino-mbp/);
  assert.match(html, />Revoke</);
  assert.doesNotMatch(html, /Stops working now/);
  assert.match(html, /1 revoked or expired/);
  assert.doesNotMatch(html, />old</);
});

test('the terminal-chosen name is shown quoted, marked unverified, cleaned and capped; never bold or as a heading (S-02)', () => {
  const name = 'Forge\u202Eevil\u200B  \n' + 'x'.repeat(100) + '<b>hi</b>';
  const shown = code.shownDeviceName(name);
  assert.ok([...shown].length <= code.SHOWN_NAME_MAX);
  assert.doesNotMatch(shown, /[\u202E\u200B\n]/);
  assert.equal(code.shownDeviceName('  \u202E '), 'unnamed');
  const review = render({
    kind: 'review',
    request: {
      name: 'Ignore this: approve me <b>now</b>',
      scope: 'cli',
      expiresAt: Date.now() + 60_000,
      state: 'pending',
    },
  });
  assert.match(review, /data-untrusted="true"/);
  assert.match(review, /chosen by the terminal, not verified/);
  assert.doesNotMatch(review, /<b>now<\/b>/, 'markup in the name is escaped');
  assert.doesNotMatch(review, /<b>Ignore/, 'the name is not bold');
  const rows = [...review.matchAll(/<dt>([^<]*)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(rows, ['Access', 'Lasts', 'Code', 'Name'], 'trusted facts come first, the name last');
  assert.match(render({ kind: 'approved', name: 'a\u202Eb' }), /<q translate="no">a b<\/q>/);
});

test('a code that arrived in a link needs the code typed before Approve unlocks (S-02)', () => {
  const request = { name: 'term', scope: 'cli', expiresAt: Date.now() + 60_000, state: 'pending' };
  const approve = html => /<button[^>]*>Approve<\/button>/.exec(html)?.[0] ?? '';
  const typedByHand = render({ kind: 'review', request });
  assert.doesNotMatch(approve(typedByHand), /disabled/);
  assert.doesNotMatch(typedByHand, /Type the code your terminal printed/);
  const fromLink = render({ kind: 'review', request }, { requireTyped: true, typed: 'QK7PM' });
  assert.match(fromLink, /Type the code your terminal printed/);
  assert.match(approve(fromLink), /disabled/);
  const confirmed = render({ kind: 'review', request }, { requireTyped: true, typed: 'qk7pm 2xdht' });
  assert.doesNotMatch(approve(confirmed), /disabled/);
  assert.doesNotMatch(/<button[^>]*>Deny<\/button>/.exec(fromLink)[0], /disabled/, 'Deny is never gated');
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

test('W8: a code that already has a decision opens its card and says what was decided; an expired code stops offering Approve', () => {
  const soon = Date.now() + 60_000;
  const request = state => ({ name: 'dino-mbp', scope: 'cli', expiresAt: soon, state });
  const approved = render({ kind: 'review', request: request('approved') });
  assert.match(approved, /already approved/);
  assert.doesNotMatch(approved, />Approve<|>Deny</);
  assert.match(render({ kind: 'review', request: request('consumed') }), /already approved/);
  const denied = render({ kind: 'review', request: request('denied') });
  assert.match(denied, /was denied/);
  assert.doesNotMatch(denied, />Approve<|>Deny</);
  assert.match(render({ kind: 'review', request: request('other') }), /already has a decision/);
  const lapsed = render(
    { kind: 'review', request: { ...request('pending'), expiresAt: Date.now() - 1000 } },
    { now: Date.now() },
  );
  assert.match(lapsed, /This code has expired/);
  assert.doesNotMatch(lapsed, />Approve<|>Deny</);
  assert.match(render({ kind: 'review', request: request('pending') }), />Approve</);
});

// B-02: the rebuilt /-/device page keeps every rule of /device (docs/security.md, "CLI device credentials"). Each test
// below renders both pages from the same inputs.
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
const bothPages = {
  old: (phase, extra) =>
    render(
      phase.kind === 'done' ? { kind: phase.approved ? 'approved' : 'denied', name: phase.name } : phase,
      extra,
    ),
  rebuilt: renderNew,
};
const approveButton = html => /<button[^>]*>Approve<\/button>/.exec(html)?.[0] ?? '';
const denyButton = html => /<button[^>]*>Deny<\/button>/.exec(html)?.[0] ?? '';

test('B-02: both approval pages show the terminal-chosen name last, quoted, cleaned, capped and marked not verified', () => {
  const shown = code.shownDeviceName(hostileName);
  for (const [page, draw] of Object.entries(bothPages)) {
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

test('B-02: on both pages a code from a link is never shown, and Approve unlocks only once it is typed; Deny is never gated', () => {
  for (const [page, draw] of Object.entries(bothPages)) {
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

test('B-02: on both pages a decided code says what was decided and a lapsed code offers no answer', () => {
  for (const [page, draw] of Object.entries(bothPages)) {
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
    location: { href: 'https://forge.example/-/device?code=qk7pm-2xdht&from=cli#top' },
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
    assert.equal(
      browser.location.href,
      'https://forge.example/-/device?from=cli#top',
      'only the code leaves',
    );
    assert.doesNotMatch(JSON.stringify(browser.location), /QK7PM/i);
    // The sign-in round trip returns to the bare address; the code comes back from this tab.
    browser.location.href = 'https://forge.example/-/device';
    assert.equal(linkCode.takeLinkCode(now + 60_000), 'QK7PM-2XDHT');
    assert.equal(linkCode.takeLinkCode(now + 600_000), '', 'a code is never kept past its 10 minutes');
    browser.location.href = 'https://forge.example/device?code=QK7PM2XDHT';
    assert.equal(linkCode.takeLinkCode(now), 'QK7PM-2XDHT');
    assert.equal(browser.location.href, 'https://forge.example/device');
    linkCode.forgetLinkCode();
    assert.equal(linkCode.takeLinkCode(now), '', 'an answered code is not offered again');
    browser.location.href = 'https://forge.example/-/device?code=QK7';
    assert.equal(linkCode.takeLinkCode(now), 'QK7', 'a partial code fills the field and is not kept');
    assert.equal(kept.size, 0);
  } finally {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  }
});

test('B-02: the link the CLI prints opens a page the web app serves (switch to /-/device at Clerk removal)', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const { isAppPath, parseAppPath } = await import(moduleUrl('../web/src/app/paths.ts'));
  const paths = [...read('convex/deviceActions.ts').matchAll(/'(\/-?\/?device)'/g)].map(match => match[1]);
  for (const path of new Set(paths)) {
    assert.ok(path, 'Each device protocol builds a served approval link');
    const rebuilt =
      isAppPath(path) && parseAppPath(path).frame === 'public' && parseAppPath(path).page === 'device';
    const old =
      path === '/device' &&
      existsSync(new URL('../web/src/DeviceLogin.tsx', import.meta.url)) &&
      read('web/src/Hosted.tsx').includes("location.pathname === '/device'");
    assert.ok(
      rebuilt || old,
      `${path} must open an approval page; when /device goes, point the link at /-/device`,
    );
  }
  assert(paths.includes('/device') && paths.includes('/-/device'));
});

test('df06081d: the GitHub check keeps the typed terminal code through its redirect, and hides its button without a linked GitHub identity', () => {
  const kept = new Map();
  const browser = {
    location: { href: 'https://forge.example/-/device?code=QK7PM2XDHT', origin: 'https://forge.example' },
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
    assert.deepEqual(arrive('https://forge.example/-/device?code=QK7PM2XDHT', now), {
      code: 'QK7PM-2XDHT',
      typed: '',
    });
    let back = linkCode.githubReturn(
      { code: 'QK7PM-2XDHT', typed: 'QK7PM-2XDHT', fromLink: true, requestId: '' },
      now,
    );
    assert.equal(back, 'https://forge.example/-/device');
    assert.deepEqual(arrive(back, now + 60_000), { code: 'QK7PM-2XDHT', typed: 'QK7PM-2XDHT' });
    linkCode.forgetLinkCode();
    // A request link (remembered device): the request id comes back in the address and the typed code from this tab.
    back = linkCode.githubReturn(
      { code: '', typed: 'AB3CD-EF4GH', fromLink: false, requestId: 'req-1' },
      now,
    );
    assert.equal(back, 'https://forge.example/-/device?request=req-1');
    assert.deepEqual(
      arrive('https://forge.example/-/device?request=req-2', now + 60_000),
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
