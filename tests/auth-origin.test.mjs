// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authState, resolveAuthToken, writeAuth } from '../dist/auth-store.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { hostedRunSubscription } from '../dist/hosted-agent-observe.js';
import { hostedAgentAddressSchema } from '../dist/hosted-address.js';
import { hostedLaneCheckoutMarkerSchema } from '../dist/hosted-lane-checkout-marker.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-auth-origin-'));
  const names = ['XDG_CONFIG_HOME', 'FORGE_AUTH_TOKEN', 'FORGE_DEPLOYMENT_URL'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-origin-token';
  process.env.FORGE_DEPLOYMENT_URL = 'https://trusted.example';
  t.after(() => {
    for (const [name, value] of previous)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(directory, { recursive: true, force: true });
  });
}
const refused = error => error.code === 'AUTH_REQUIRED';

test('checkout origins cannot redirect an environment credential through exchange or live waits', t => {
  fixture(t);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('refused origins must not make a network request');
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  assert.throws(
    () => new ConvexExchange('https://other.example', undefined, 'project', randomUUID(), null),
    refused,
  );
  assert.throws(() => hostedRunSubscription({ url: 'https://other.example', projectId: 'project' }), refused);
  assert.equal(resolveAuthToken('https://trusted.example/'), 'synthetic-origin-token');
});

test('environment credentials need a configured or previously authenticated origin', t => {
  fixture(t);
  delete process.env.FORGE_DEPLOYMENT_URL;
  assert.throws(() => authState('https://other.example'), refused);
  writeAuth({ defaultDeployment: 'https://trusted.example', deployments: {} });
  assert.equal(authState('https://trusted.example').kind, 'envToken');
  const saved = {
    token: 'synthetic-saved',
    credentialId: 'device',
    expiresAt: 1,
    name: 'test',
    scope: 'cli',
  };
  writeAuth({ deployments: { 'https://saved.example': saved } });
  assert.equal(authState('https://saved.example').kind, 'envToken');
  process.env.FORGE_DEPLOYMENT_URL = 'https://trusted.example';
  assert.throws(() => authState('https://saved.example'), refused, 'explicit binding takes precedence');
  assert.equal(resolveAuthToken('https://other.example', ''), undefined);
});

test('hosted address and checkout marker origins accept HTTPS or loopback only', () => {
  for (const url of [
    'http://other.example',
    'https://user:password@other.example',
    'https://other.example/path',
    'file:///tmp/source',
  ]) {
    assert.equal(hostedAgentAddressSchema.safeParse({ url, projectId: 'project' }).success, false, url);
    assert.equal(hostedLaneCheckoutMarkerSchema.shape.url.safeParse(url).success, false, url);
  }
  for (const url of ['https://trusted.example', 'http://127.0.0.1:4321'])
    assert.equal(hostedAgentAddressSchema.safeParse({ url, projectId: 'project' }).success, true);
});
