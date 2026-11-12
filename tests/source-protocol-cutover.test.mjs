// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { physicalProject } from './convex-physical-manifest-fixture.mjs';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { directCommandSchema } from '../dist/hosted-actions-direct.js';
const source = await import(moduleUrl('../convex/projectHostedActionsSource.ts'));
const api = await import(moduleUrl('../convex/projectStateSourceApi.ts'));
const downloadsApi = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const capabilities = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
function qualify(f, rootless = false) {
  f.s.patch('hostedProjects', f.s.projectId, { sourceManifestVersion: 2 });
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', row._id, {
    r2Key: `v1/p/${f.s.projectId}/o/${row.digest}`,
    ...(rootless ? { statePhysical: undefined, stateGeneration: 1 } : {}),
  });
}
test('only an enabled trusted source step qualifies a project, and later skipped roots retain that contract', async t => {
  const f = await physicalProject(t, 10);
  const skipped = await f.compose(f.files, f.base, 'main-0', false);
  assert.equal(f.s.tables.hostedProjects.get(f.s.projectId).sourceManifestVersion, undefined);
  const enabled = await f.compose(f.files, skipped.head, 'main-0', true);
  await f.seed();
  assert.equal(f.s.tables.hostedProjects.get(f.s.projectId).sourceManifestVersion, 2);
  await f.compose(f.files, enabled.head, 'main-0', false);
  assert.equal(f.s.tables.hostedProjects.get(f.s.projectId).sourceManifestVersion, 2);
});
test('qualified projects require protocol 2 at discovery, State bootstrap and runner selection', async t => {
  const f = await physicalStateSourceFixture(t, 10);
  qualify(f);
  await assert.rejects(f.heads(), code('CLI_UPGRADE_REQUIRED'));
  await assert.rejects(
    f.source({ state: f.s.state.sha256, digests: [], all: true }),
    code('CLI_UPGRADE_REQUIRED'),
  );
  await assert.rejects(
    f.s.transaction('old-state-bootstrap', downloadsApi.describe, {
      projectId: f.s.projectId,
      digests: [f.s.state.sha256],
      stateSource: true,
    }),
    code('CLI_UPGRADE_REQUIRED'),
  );
  await assert.rejects(
    f.s.transaction('old-discovery', capabilities.capabilities, {
      projectId: f.s.projectId,
      features: ['source-state'],
    }),
    code('CLI_UPGRADE_REQUIRED'),
  );
  const current = JSON.parse(
    await f.s.transaction('current-discovery', capabilities.capabilities, {
      projectId: f.s.projectId,
      features: ['source-state-v2'],
    }),
  );
  assert(current.features.includes('source-state-v2'));
  const reply = expandSourceGrants(
    await f.source({ version: 2, state: f.s.state.sha256, digests: [], all: true }),
  );
  assert.equal(reply.mode, 'runs');
  assert.equal(
    f.calls.filter(call => call.name === 'projectStateSourceSelection:runner').length,
    3,
    'one refused old selection and two current selections',
  );
});
test('protocol 2 cannot use the old arbitrary-digest runner resolver or forge a State proof over HTTP', async t => {
  const f = await physicalStateSourceFixture(t, 2);
  qualify(f);
  const command = directCommandSchema.parse({
    kind: 'source',
    version: 2,
    digests: [f.entries[0].sha256],
    batch: true,
    stateProof: true,
  });
  assert.equal('stateProof' in command, false);
  const { kind: _kind, ...args } = command;
  await assert.rejects(
    f.s.transaction('unbound-runner', source.resolve, { ...f.input, ...args }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(
    f.s.transaction('outside-bound-runner', source.resolve, {
      ...f.input,
      version: 2,
      digests: [f.entries[0].sha256],
      batch: true,
      bound: true,
    }),
    code('SOURCE_UNAVAILABLE'),
  );
  const heads = JSON.parse(
    await f.s.transaction('current-bound-runner', source.resolve, {
      ...f.input,
      version: 2,
      digests: [f.s.state.sha256],
      batch: true,
      bound: true,
    }),
  );
  assert.equal(heads.sourceVersion, 2);
});
test('qualified rootless clone uses the complete State-checked catalog for every member', async t => {
  const { HostedCheckoutDownloads } = await import('../dist/hosted-checkout-downloads.js');
  const f = await physicalStateSourceFixture(t, 1001);
  qualify(f, true);
  const actions = [];
  const client = new HostedCheckoutDownloads({
    projectId: f.s.projectId,
    sourceStateReads: true,
    sourceStateVersion: 2,
    client: {
      mutation: (_ref, args) => f.s.transaction('qualified-bootstrap', downloadsApi.describe, args),
      action: async (_ref, args) => {
        actions.push(args);
        return api.read._handler(f.ctx, args);
      },
    },
  });
  await client.objects([f.s.state.sha256]);
  client.selectState(f.s.state.sha256, f.files);
  assert.equal(await client.prepareObjects(f.files.map(file => file.blob)), null);
  const pins = await client.objects(f.files.map(file => file.blob));
  assert.deepEqual(pins.map(pin => pin.sha256).sort(), f.files.map(file => file.blob).sort());
  assert(actions.length > 0);
  assert(actions.every(args => args.state === f.s.state.sha256 && args.version === 2));
});
test('qualified rootless Actions materialization stays State-bound and verifies all file bytes', async t => {
  const { ActionsJobClient } = await import('../dist/hosted-actions-job-client.js');
  const { hostedActionsCapabilities } = await import('../dist/hosted-actions-capabilities.js');
  const { materializeActionsSource } = await import('../dist/hosted-actions-job-source.js');
  const { temporaryDirectory } = await import('../scripts/test-temp.mjs');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = await physicalStateSourceFixture(t, 1001),
    root = temporaryDirectory(t, 'forge-protocol2-');
  qualify(f, true);
  mkdirSync(join(root, 'objects'));
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, fetch);
  client.run = f.run;
  client.capabilities = [...hostedActionsCapabilities];
  const commands = [];
  t.mock.method(client, 'call', async original => {
    const command = { ...original, version: 2 };
    commands.push(command);
    if (command.state) return expandSourceGrants(await f.source(command));
    assert(command.bound, 'every non-State command is a bound State bootstrap');
    const { kind: _kind, ...args } = command;
    return JSON.parse(
      await f.ctx.runMutation(makeFunctionReference('projectHostedActionsSource:resolve'), {
        ...f.input,
        ...args,
      }),
    );
  });
  await materializeActionsSource(client, join(root, 'candidate'), join(root, 'objects'));
  assert(commands.some(command => command.state));
  for (const [i, file] of f.files.entries())
    assert.equal(readFileSync(join(root, 'candidate', file.path), 'utf8'), `source ${i}`);
  assert(
    f.calls.some(
      call =>
        getFunctionName(makeFunctionReference(call.name)) === 'projectHostedActionsSource:resolve' &&
        call.args.stateProof,
    ),
  );
});
