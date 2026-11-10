// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { hostedAgentActions, hostedAgentPlanningActions } from '../dist/hosted-agent-contract.js';
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
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
  assert.deepEqual(
    result.actions,
    hostedAgentActions.filter(action => action !== 'resolve' && !hostedAgentPlanningActions.includes(action)),
  );
  // Backlog actions are advertised only to clients that ask, so released clients keep parsing.
  const planning = await s
    .call('capabilities', capabilities, { projectId: s.projectId, planningVersion: 1 }, 'owner')
    .then(JSON.parse);
  assert.deepEqual(
    planning.actions,
    hostedAgentActions.filter(action => action !== 'resolve'),
  );
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
  // Two discovery reads plus one account read that shows the caller their own handle.
  assert(s.counts.every(count => count.ranges <= 3 && count.documents <= 3 && count.writes === 0));
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

test('default Convex discovery needs no worker configuration and retired Modal remains unavailable even with old pins', async () => {
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
    assert.equal((await s.read('owner')).sourceWorkerConfigured, false);
    process.env.FORGE_SOURCE_PROVIDER = 'unknown';
    assert.equal((await s.read('owner')).sourceWorkerConfigured, false);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('resolve advertisement is opt-in so released strict capability readers remain compatible', async () => {
  const s = setup();
  assert(!(await s.read('owner')).actions.includes('resolve'));
  const current = JSON.parse(
    await s.call('capabilities', capabilities, { projectId: s.projectId, resolveVersion: 1 }, 'owner'),
  );
  assert.deepEqual(
    current.actions,
    hostedAgentActions.filter(action => !hostedAgentPlanningActions.includes(action)),
  );
});

test('contract features: the server names the asked features its code implements, only when asked (a83b6fd5)', async () => {
  const s = setup();
  const ask = features =>
    s.call('capabilities', capabilities, { projectId: s.projectId, features }, 'owner').then(JSON.parse);
  // Released strict readers never ask, so they never see the field.
  assert.equal('features' in (await s.read('owner')), false);
  assert.deepEqual((await ask(['planning-put-keeps-omitted', 'not-implemented-yet'])).features, [
    'planning-put-keeps-omitted',
  ]);
  assert.deepEqual((await ask([])).features, []);
  // Every name this build's CLI may ask for is implemented by this build's server.
  assert.deepEqual((await ask([...hostedContractFeatures])).features, [...hostedContractFeatures]);
  await assert.rejects(ask(Array.from({ length: 65 }, (_, index) => `f${index}`)), code('BAD_ARGUMENT'));
  assert(s.counts.every(count => count.writes === 0));
});
test('capabilities-main: discovery carries main exactly as projectHostedChannels:current, from its one channel read (686ecdde)', async () => {
  const s = setup();
  const { current } = await import(moduleUrl('../convex/projectHostedChannels.ts'));
  const ask = features =>
    s.call('capabilities', capabilities, { projectId: s.projectId, features }, 'owner').then(JSON.parse);
  assert.equal('main' in (await ask(['capabilities-main'])), false, 'unseeded main is not carried');
  const main = {
    schema: 2,
    projectId: s.projectId,
    snapshotId: 'snapshot',
    sourceRevision: 3,
    authority: { mode: 'server', epoch: 2 },
    channel: 'main',
    head: 'a'.repeat(64),
    receipt: { id: 'receipt', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const channel = s.insert('projectHostedChannels', {
    projectId: s.projectId,
    name: 'main',
    selection: JSON.stringify(main),
    operationId: 'synthetic',
  });
  s.counts.length = 0;
  const carried = await ask(['capabilities-main']);
  const read = JSON.parse(await s.call('current', current, { projectId: s.projectId }, 'owner'));
  assert.deepEqual(carried.main, read);
  assert.equal(carried.mainReady, true);
  // The same documents as discovery without the feature: the channel row is read once.
  assert(s.counts[0].documents <= 3, `${s.counts[0].documents} documents`);
  // Only callers that ask see it; a main whose authority differs (current refuses it) is not carried.
  assert.equal('main' in (await s.read('owner')), false);
  s.patch('projectHostedChannels', channel, {
    selection: JSON.stringify({ ...main, authority: { mode: 'server', epoch: 1 } }),
  });
  assert.equal('main' in (await ask(['capabilities-main'])), false);
  await assert.rejects(
    s.call('current', current, { projectId: s.projectId }, 'owner'),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
});
test('capabilities-main: the release check takes main only from this command’s read of the same project', async () => {
  const { noteEarlyCapabilities, carriedMain } = await import('../dist/hosted-capabilities-carried-main.js');
  const main = {
    schema: 2,
    projectId: 'carried-project',
    snapshotId: 'snapshot',
    sourceRevision: 1,
    authority: { mode: 'server', epoch: 1 },
    channel: 'main',
    head: 'b'.repeat(64),
    receipt: { id: 'receipt', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  assert.equal(await carriedMain('https://carried.invalid', 'carried-project'), null, 'no read: no main');
  noteEarlyCapabilities('https://carried.invalid/', 'carried-project', Promise.resolve({ main }));
  assert.deepEqual(await carriedMain('https://carried.invalid', 'carried-project'), main);
  assert.equal(await carriedMain('https://other.invalid', 'carried-project'), null);
  assert.equal(await carriedMain('https://carried.invalid', 'another-project'), null);
  // An older server (no main), a failed read or a main of another project: the check reads current.
  noteEarlyCapabilities('https://carried.invalid', 'carried-project', Promise.resolve({ mainReady: true }));
  assert.equal(await carriedMain('https://carried.invalid', 'carried-project'), null);
  noteEarlyCapabilities('https://carried.invalid', 'carried-project', Promise.reject(new Error('offline')));
  assert.equal(await carriedMain('https://carried.invalid', 'carried-project'), null);
  noteEarlyCapabilities(
    'https://carried.invalid',
    'carried-project',
    Promise.resolve({ main: { ...main, projectId: 'another-project' } }),
  );
  assert.equal(await carriedMain('https://carried.invalid', 'carried-project'), null);
});
