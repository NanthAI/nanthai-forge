// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSealedIdentity } from '../dist/sealed-identity.js';
import { writeAuth } from '../dist/auth-store.js';
const token = (sub, signIn = 'sign-in') =>
  `header.${Buffer.from(JSON.stringify({ sub, forgeCredential: 'synthetic-device', forgeSignIn: signIn })).toString('base64url')}.signature`;
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-identity-')),
    old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(() => {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
test('device keys and pin key persist across repeated stable sign-ins without deriving from session material', async t => {
  setup(t);
  const a = await localSealedIdentity('https://synthetic.convex.cloud', token('synthetic-account'));
  const b = await localSealedIdentity(
    'https://synthetic.convex.cloud',
    token('synthetic-account', 'new-sign-in'),
  );
  for (const name of ['id', 'sign', 'enc', 'pinKey', 'bindSig']) assert.deepEqual(a.keys[name], b.keys[name]);
  assert.notDeepEqual(a.keys.sign, a.keys.enc);
  assert.notDeepEqual(a.keys.pinKey, a.keys.sign);
  for (const keys of [a.keys, b.keys]) for (const name of ['sign', 'enc', 'pinKey']) keys[name].fill(0);
});
test('renewal cannot silently choose a new account namespace or erase the existing secret pins', async t => {
  setup(t);
  const deployment = 'https://synthetic.convex.cloud';
  writeAuth({
    deployments: {
      [deployment]: {
        token: token('synthetic-account'),
        credentialId: 'synthetic-device',
        expiresAt: Date.now() + 60000,
        name: 'synthetic',
        scope: 'cli',
        sealedAccount: 'synthetic-account',
      },
    },
  });
  const a = await localSealedIdentity(deployment, token('synthetic-account'));
  await assert.rejects(localSealedIdentity(deployment, token('another-account')), {
    code: 'AUTH_OPERATION_CHANGED',
  });
  const b = await localSealedIdentity(deployment, token('synthetic-account'));
  assert.deepEqual(a.keys.id, b.keys.id);
  for (const keys of [a.keys, b.keys]) for (const name of ['sign', 'enc', 'pinKey']) keys[name].fill(0);
});
test('configuration overrides cannot place device secret keys in the selected source tree', async t => {
  const directory = setup(t);
  process.env.XDG_CONFIG_HOME = join(directory, 'tree', 'config');
  await assert.rejects(
    localSealedIdentity(
      'https://synthetic.convex.cloud',
      token('synthetic-account'),
      join(directory, 'tree'),
    ),
    { code: 'SECRETS_FORMAT_REFUSED' },
  );
  assert.equal(existsSync(join(directory, 'tree', 'config', 'forge', 'sealed')), false);
});

test('an explicit account token override selects its own namespace without changing saved trust', async t => {
  setup(t);
  const deployment = 'https://synthetic.convex.cloud';
  writeAuth({
    deployments: {
      [deployment]: {
        token: token('original'),
        sealedAccount: 'original',
        scope: 'cli',
        name: 'synthetic',
        expiresAt: Date.now() + 60000,
      },
    },
  });
  const a = await localSealedIdentity(deployment, token('original')),
    old = process.env.FORGE_AUTH_TOKEN;
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = old;
  });
  process.env.FORGE_AUTH_TOKEN = token('explicit-other');
  const b = await localSealedIdentity(deployment, process.env.FORGE_AUTH_TOKEN);
  assert.notEqual(a.directory, b.directory);
  assert.notDeepEqual(a.keys.id, b.keys.id);
  delete process.env.FORGE_AUTH_TOKEN;
  const c = await localSealedIdentity(deployment, token('original'));
  assert.deepEqual(a.keys.id, c.keys.id);
  for (const keys of [a.keys, b.keys, c.keys])
    for (const name of ['sign', 'enc', 'pinKey']) keys[name].fill(0);
});
