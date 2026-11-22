// SPDX-License-Identifier: Apache-2.0
// Per-visitor limits (Item b6588425, "Per-client limits"): device sign-in start and renewal go through the site's edge
// (netlify/functions/device-auth.mts), which forwards only a keyed hash of the platform-reported address; the backend
// charges that visitor (convex/visitorBudget.ts) before the deployment budget. Two synthetic visitors keep separate
// budgets, the noisy one is refused with a clear message, and no address reaches a row, a reply, a header or a log.
// The signed-out source-read case is in public-code-access.test.mjs (it needs that file's public project fixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleSource, moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { signedDevice } from '../dist/device-key.js';
import { clientHash, clientKey } from '../dist/client-hash.js';
import { devicePost } from '../dist/device-endpoint.js';

const modules = {
  deviceStore: await import(moduleUrl('../convex/deviceStore.ts')),
  deviceStableStore: await import(moduleUrl('../convex/deviceStableStore.ts')),
};
const stableActions = await import(moduleUrl('../convex/deviceStableActions.ts'));
const visitorBudget = await import(moduleUrl('../convex/visitorBudget.ts'));
const { default: http } = await import(moduleUrl('../convex/http.ts'));
const edge = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource('../netlify/functions/device-auth.mts')).toString('base64')}`
);

const BACKEND = 'https://forge-test.convex.site';
const SITE = 'https://forge.example';
const NOISY = '203.0.113.7';
const QUIET = '2001:db8:1:2::5';
const QUIET_NEIGHBOUR = '2001:db8:1:2:ffff::9';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

function environment(t, values) {
  const previous = Object.keys(values).map(name => [name, process.env[name]]);
  for (const [name, value] of Object.entries(values))
    value === undefined ? delete process.env[name] : (process.env[name] = value);
  t.after(() =>
    previous.forEach(([name, value]) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value),
    ),
  );
}

/** The real edge function, the real Convex route, actions and mutations, on one in-memory store. Every forwarded
 * request, reply and console line is kept so the test can look for the address in all of them. */
function deployment(t, { siteKey = 'synthetic-site-device-key' } = {}) {
  environment(t, {
    FORGE_CLI_PRIVATE_KEY: privateKey,
    FORGE_CLI_ISSUER: BACKEND,
    FORGE_WEB_URL: SITE,
    FORGE_CONVEX_SITE_URL: BACKEND,
    FORGE_SITE_DEVICE_KEY: siteKey ?? undefined,
    FORGE_CLIENT_HASH_KEY: 'synthetic-client-hash-key',
    FORGE_PUBLIC_ABUSE_BUDGETS: undefined,
  });
  const s = state();
  for (const name of ['deviceCodes', 'deviceAttempts', 'cliCredentials']) s.tables[name] = new Map();
  s.ctx.runMutation = async (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return modules[module][name]._handler(s.ctx, args);
  };
  const routeCtx = {
    runAction: (ref, args) => stableActions[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
  };
  const seen = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...args) => seen.push(args.map(String).join(' ')));
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const request = new Request(input, init);
    assert.ok(request.url.startsWith(`${BACKEND}/auth/device/`), 'the edge calls only the backend');
    const body = await request.clone().text();
    seen.push(request.url, JSON.stringify([...request.headers]), body);
    const handler = http.getRoutes().find(([path]) => path === new URL(request.url).pathname)[2];
    const response = await handler._handler(routeCtx, request);
    seen.push(await response.clone().text());
    return response;
  });
  const device = () => {
    const key = generateKeyPairSync('ed25519');
    return {
      id: randomUUID(),
      publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  };
  const via = async (ip, operation, body) => {
    const response = await edge.default(
      new Request(`${SITE}/auth/device/${operation}`, { method: 'POST', body: JSON.stringify(body) }),
      { ip },
    );
    const reply = await response.json();
    seen.push(JSON.stringify(reply));
    return { status: response.status, reply };
  };
  const startBody = (extra = {}) => {
    const operationId = randomUUID(),
      clientNonce = randomBytes(32).toString('hex'),
      name = 'Synthetic CLI',
      scope = 'cli';
    return {
      operationId,
      clientNonce,
      name,
      scope,
      device: signedDevice(device(), BACKEND, 'start', operationId, {
        clientNonce,
        name,
        scope,
        projectId: null,
      }),
      ...extra,
    };
  };
  const start = (ip, extra) => via(ip, 'start-v2', startBody(extra));
  const renew = ip => {
    const operationId = randomUUID();
    return via(ip, 'renew', { operationId, device: signedDevice(device(), BACKEND, 'renew', operationId) });
  };
  const leaks = (...addresses) => {
    const text = [
      JSON.stringify([...Object.values(s.tables)].map(table => [...table.values()])),
      ...seen,
    ].join('\n');
    return addresses.filter(address => text.includes(address) || text.includes(clientKey(address)));
  };
  return { s, start, renew, leaks, seen };
}

test('two visitors keep their own sign-in budgets: the noisy one is refused with a clear message, the other is served', async t => {
  let now = Date.UTC(2026, 10, 22, 12);
  t.mock.method(Date, 'now', () => now);
  const d = deployment(t);
  const { perMinute, perHour } = visitorBudget.VISITOR_BUDGET.device;
  assert.deepEqual([perMinute, perHour], [10, 30], 'owner numbers 2026-11-22');
  // Starts and renewals share the window: nine starts and one renewal of an unknown device.
  for (let i = 0; i < perMinute - 1; i++) {
    const { status, reply } = await d.start(NOISY);
    assert.equal(status, 200);
    assert.match(reply.device_code, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(await d.renew(NOISY), { status: 200, reply: { status: 'unapproved' } });
  const codes = d.s.tables.deviceCodes.size;
  const refused = await d.start(NOISY);
  assert.equal(refused.status, 429);
  assert.equal(refused.reply.error, 'slow_down');
  assert.match(refused.reply.error_description, /^Too many sign-ins from your network \(at most 10 a minute/);
  assert.equal(d.s.tables.deviceCodes.size, codes, 'a refused start stores nothing');
  // The quiet visitor is served while the noisy one waits, and a neighbour in its /64 shares its budget.
  assert.equal((await d.start(QUIET)).status, 200);
  assert.equal((await d.start(QUIET_NEIGHBOUR)).status, 200);
  const owners = [...d.s.tables.deviceAttempts.values()]
    .map(row => row.owner)
    .filter(o => o.startsWith('visitor:'));
  assert.equal(owners.length, 2, 'one row per visitor, the /64 neighbour included');
  // The hour window: two more full minutes reach 30, then the noisy visitor waits for the hour.
  for (let minute = 0; minute < 2; minute++) {
    now += 61_000;
    for (let i = 0; i < perMinute; i++) assert.equal((await d.start(NOISY)).status, 200);
  }
  now += 61_000;
  const hourly = await d.start(NOISY);
  assert.equal(hourly.status, 429);
  assert.match(hourly.reply.error_description, /30 an hour\)\. Try again in \d+ min\.$/);
  assert.equal((await d.start(QUIET)).status, 200, 'the quiet visitor is still served');
  now += 60 * 60_000;
  assert.equal((await d.start(NOISY)).status, 200, 'a new hour serves the noisy visitor again');
  assert.deepEqual(
    d.leaks(NOISY, QUIET, QUIET_NEIGHBOUR),
    [],
    'no address in rows, replies, headers or logs',
  );
});

test('with the site key set, the backend refuses direct and forged sign-ins and points at the site; JSON cannot pick a visitor', async t => {
  const d = deployment(t);
  const handler = path => http.getRoutes().find(([value]) => value === path)[2];
  const refusedRun = { runAction: () => assert.fail('A direct sign-in must not run.') };
  for (const headers of [
    {},
    { 'x-forge-client': 'a'.repeat(64) },
    { 'x-forge-site-device': 'wrong', 'x-forge-client': 'a'.repeat(64) },
  ]) {
    const response = await handler('/auth/device/start-v2')._handler(
      refusedRun,
      new Request(`${BACKEND}/auth/device/start-v2`, { method: 'POST', headers, body: '{}' }),
    );
    assert.equal(response.status, 421);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'use_site',
      site: SITE,
      error_description: 'Sign-ins go through the Forge site. Update the CLI with: nforge update',
    });
  }
  const missing = await handler('/auth/device/renew')._handler(
    refusedRun,
    new Request(`${BACKEND}/auth/device/renew`, {
      method: 'POST',
      headers: { 'x-forge-site-device': 'synthetic-site-device-key' },
      body: '{}',
    }),
  );
  assert.equal(missing.status, 400, 'the site must name the visitor');
  // A `client` in the request JSON is ignored: the charge goes to the edge's hash of the address.
  assert.equal((await d.start(NOISY, { client: 'f'.repeat(64) })).status, 200);
  const expected = await clientHash('synthetic-client-hash-key', NOISY);
  assert.deepEqual(
    [...d.s.tables.deviceAttempts.values()].map(row => row.owner).filter(o => o.startsWith('visitor:')),
    [`visitor:device:${expected}`],
  );
});

test('without the site key the backend keeps its direct sign-in, so an environment without the site edge still works', async t => {
  deployment(t, { siteKey: null });
  const response = await http
    .getRoutes()
    .find(([path]) => path === '/auth/device/start-v2')[2]
    ._handler(
      { runAction: async () => JSON.stringify({ status: 'removed' }) },
      new Request(`${BACKEND}/auth/device/start-v2`, { method: 'POST', body: '{}' }),
    );
  assert.equal(response.status, 200);
});

test('the edge refuses to forward when it cannot key the visitor, and never forwards an address', async t => {
  const d = deployment(t);
  for (const ip of [undefined, '', 'not-an-address']) {
    const response = await edge.default(
      new Request(`${SITE}/auth/device/start-v2`, { method: 'POST', body: '{}' }),
      { ip },
    );
    assert.equal(response.status, 503);
  }
  assert.equal(d.seen.length, 0, 'nothing reached the backend');
  assert.deepEqual(edge.config.path, ['/auth/device/start-v2', '/auth/device/renew']);
});

test('the visitor key is a keyed hash of the address: IPv6 by /64, mapped IPv4 as IPv4, nothing without a key', async () => {
  assert.equal(clientKey('203.0.113.7'), '4:203.0.113.7');
  assert.equal(clientKey('::ffff:203.0.113.7'), '4:203.0.113.7');
  assert.equal(clientKey('::ffff:cb00:7107'), '4:203.0.113.7');
  assert.equal(clientKey('[2001:DB8:1:2::5]'), '6:2001:0db8:0001:0002::/64');
  assert.equal(clientKey('2001:db8:1:2:ffff::9'), clientKey('2001:db8:1:2::5'));
  assert.notEqual(clientKey('2001:db8:1:3::5'), clientKey('2001:db8:1:2::5'));
  for (const bad of ['', '999.1.1.1', '1:::2', 'g::1', '1:2:3:4:5:6:7:8:9', 'example.com'])
    assert.equal(clientKey(bad), null);
  const first = await clientHash('key-one', NOISY);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, await clientHash('key-two', NOISY), 'another key gives another hash');
  assert.equal(await clientHash(undefined, NOISY), null);
});

test('a new visitor row removes at most two expired rows and never another kind of attempt row', async () => {
  const s = state();
  s.tables.deviceAttempts = new Map();
  const now = Date.UTC(2026, 10, 22, 12);
  for (let i = 0; i < 6; i++)
    s.tables.deviceAttempts.set(`old${i}`, {
      _id: `old${i}`,
      owner: `visitor:read:${String(i).repeat(64)}`,
      windowAt: now - 2 * 3_600_000,
      count: 3,
      expiresAt: now - 3_600_000,
    });
  s.tables.deviceAttempts.set('system', {
    _id: 'system',
    owner: 'system:device-start',
    windowAt: 0,
    count: 1,
  });
  const expired = () => [...s.tables.deviceAttempts.values()].filter(row => row.expiresAt < now).length;
  assert.equal(visitorBudget.VISITOR_BUDGET.cleanup, 2);
  await visitorBudget.chargeVisitorRead(s.ctx, 'a'.repeat(64), now);
  assert.equal(expired(), 4);
  assert.ok(s.tables.deviceAttempts.has('system'));
  // A returning visitor patches its own row and removes nothing.
  await visitorBudget.chargeVisitorRead(s.ctx, 'a'.repeat(64), now + 1);
  assert.equal(expired(), 4);
  await visitorBudget.chargeVisitorRead(s.ctx, 'b'.repeat(64), now + 2);
  await visitorBudget.chargeVisitorRead(s.ctx, 'c'.repeat(64), now + 3);
  assert.equal(expired(), 0);
  assert.ok(s.tables.deviceAttempts.has('system'));
});

test('a sign-in the deployment budget refuses does not spend the visitor budget', async () => {
  const s = state();
  s.tables.deviceAttempts = new Map();
  const now = Date.UTC(2026, 10, 22, 12);
  const client = 'd'.repeat(64);
  const visitorRows = () =>
    [...s.tables.deviceAttempts.values()].filter(row => row.owner.startsWith('visitor:'));
  assert.deepEqual(await visitorBudget.takeVisitorDevice(s.ctx, client, async () => false, now), {
    error: 'slow_down',
    interval: 60,
  });
  assert.equal(visitorRows().length, 0, 'a refused call writes no visitor row');
  assert.equal(await visitorBudget.takeVisitorDevice(s.ctx, client, async () => true, now), null);
  assert.equal(visitorRows()[0].count, 1);
  // Over the visitor limit the deployment budget is not asked.
  for (let i = 1; i < 10; i++) await visitorBudget.takeVisitorDevice(s.ctx, client, async () => true, now);
  const refused = await visitorBudget.takeVisitorDevice(
    s.ctx,
    client,
    async () => assert.fail('the deployment budget must not be spent'),
    now,
  );
  assert.equal(refused.error, 'slow_down');
  assert.match(refused.error_description, /^Too many sign-ins from your network/);
});

test('a renewal over the visitor limit is refused with the same clear message', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 22, 12));
  const d = deployment(t);
  for (let i = 0; i < 10; i++) assert.equal((await d.renew(NOISY)).status, 200);
  const refused = await d.renew(NOISY);
  assert.equal(refused.status, 429);
  assert.equal(refused.reply.status, 'slow_down', 'a renewal keeps its refusal shape');
  assert.match(refused.reply.error_description, /^Too many sign-ins from your network \(at most 10 a minute/);
  assert.equal((await d.renew(QUIET)).status, 200, 'another visitor still renews');
  assert.deepEqual(d.leaks(NOISY, QUIET), []);
});

test('the CLI follows a use_site answer once to the site and keeps a direct answer from an older environment', async t => {
  const asked = [];
  let siteMode = true;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url.startsWith(BACKEND) && siteMode)
      return Response.json({ error: 'use_site', site: SITE }, { status: 421 });
    return Response.json({ ok: true });
  });
  assert.equal((await devicePost(BACKEND, 'start-v2', '{}')).status, 200);
  assert.deepEqual(asked, [`${BACKEND}/auth/device/start-v2`, `${SITE}/auth/device/start-v2`]);
  siteMode = false;
  asked.length = 0;
  assert.equal((await devicePost(BACKEND, 'renew', '{}')).status, 200);
  assert.deepEqual(asked, [`${BACKEND}/auth/device/renew`], 'an older environment answers directly');
});
