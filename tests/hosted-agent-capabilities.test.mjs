// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
const { capabilities } = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
function setup() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 2 },
  });
  return {
    ...s,
    projectId,
    read: actor => s.call('capabilities', capabilities, { projectId }, actor).then(JSON.parse),
  };
}
test('discovery reports protocol and actual project authority with constant reads and zero writes/wakes', async () => {
  const s = setup();
  let result = await s.read('owner');
  assert.deepEqual(result.actions, hostedAgentActions);
  assert.equal(result.mainReady, false);
  assert.equal(result.nativeOwnerRequired, false);
  assert.equal(result.observation, 'finite');
  assert.deepEqual(result.authority, { mode: 'server', epoch: 2 });
  s.insert('projectHostedChannels', {
    projectId: s.projectId,
    name: 'main',
    selection: '{}',
    operationId: 'synthetic',
  });
  result = await s.read('owner');
  assert.equal(result.mainReady, true);
  assert(s.counts.every(count => count.ranges <= 2 && count.documents <= 2 && count.writes === 0));
  assert(s.counts.every(count => !count.touched.some(table => /Work|SourceJob|CheckRuns/.test(table))));
});
test('legacy native authority is explicit and never advertises owner-free hosted mutations', async () => {
  const s = setup();
  s.patch('hostedProjects', s.projectId, { sourceAuthority: undefined });
  const result = await s.read('owner');
  assert.deepEqual(result.authority, { mode: 'native-owner', epoch: 0 });
  assert.deepEqual(result.actions, ['capabilities']);
});
test('discovery applies current project access, removal and device credential revocation', async () => {
  const s = setup();
  for (const actor of [null, 'stranger']) await assert.rejects(s.read(actor), code('PROJECT_UNAVAILABLE'));
  const reader = s.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  assert.equal((await s.read('reader')).actor, 'reader');
  s.tables.projectReaders.delete(reader);
  await assert.rejects(s.read('reader'), code('PROJECT_UNAVAILABLE'));
  s.insert('cliCredentials', {
    name: 'Synthetic',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    credentialId: 'synthetic',
    owner: 'owner',
    scope: 'cli',
    revoked: true,
    expiresAt: Date.now() + 100000,
  });
  await assert.rejects(s.read({ subject: 'owner', forgeCredential: 'synthetic' }), code('AUTH_REVOKED'));
  s.patch('hostedProjects', s.projectId, { removal: 'deleted' });
  await assert.rejects(s.read('owner'), code('PROJECT_UNAVAILABLE'));
});

test('default Convex discovery needs no worker configuration and explicit Modal still reports missing pins', async () => {
  const keys = [
      'FORGE_SOURCE_PROVIDER',
      'FORGE_SOURCE_WORKER',
      'FORGE_SOURCE_RUNTIME',
      'FORGE_SOURCE_KEY_ID',
    ],
    prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const key of keys) delete process.env[key];
    const s = setup();
    assert.equal((await s.read('owner')).sourceWorkerConfigured, true);
    process.env.FORGE_SOURCE_PROVIDER = 'modal';
    assert.equal((await s.read('owner')).sourceWorkerConfigured, false);
    Object.assign(process.env, {
      FORGE_SOURCE_WORKER: 'synthetic',
      FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
      FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
    });
    assert.equal((await s.read('owner')).sourceWorkerConfigured, true);
    process.env.FORGE_SOURCE_PROVIDER = 'unknown';
    assert.equal((await s.read('owner')).sourceWorkerConfigured, false);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
