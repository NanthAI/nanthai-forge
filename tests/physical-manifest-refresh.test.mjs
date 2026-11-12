// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { makeFunctionReference } from 'convex/server';
const { stateSourceGrants } = await import(moduleUrl('../convex/projectStateSourceGrants.ts'));
function replacement(f, all = false) {
  const prefix = `/synthetic/v1/p/${f.s.projectId}/o/`;
  const moved = f.root.root.chunks.filter((_pin, index) => all || index % 2 === 0).reverse();
  const body = Buffer.concat(
    moved.map(pin => f.bodies.get(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)),
  );
  const pack = { digest: digest(body), size: body.length };
  f.r2.objects.set(prefix + pack.digest, body);
  let offset = 0;
  const pins = new Map(
    moved.map(pin => {
      const next = { ...pin, pack: { ...pack, offset } };
      offset += pin.size;
      return [pin.bucket, next];
    }),
  );
  const chunks = f.root.root.chunks.map(pin => pins.get(pin.bucket) ?? pin);
  const bytes = encodePhysicalRoot({ ...f.root.root, chunks }),
    pin = { sha256: digest(bytes), size: bytes.length };
  f.r2.objects.set(prefix + pin.sha256, bytes);
  return pin;
}
function bind(f, pin) {
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', row._id, { statePhysical: pin });
}
for (const missing of [false, true])
  test(`grant planning refreshes a ${missing ? 'missing' : 'readable'} superseded root before using the catalog`, async t => {
    const f = await physicalStateSourceFixture(t, 20),
      pin = replacement(f);
    let selections = 0,
      catalog = 0;
    if (missing) f.r2.objects.delete(`/synthetic/v1/p/${f.s.projectId}/o/${f.root.pin.sha256}`);
    const value = await stateSourceGrants({
      projectId: f.s.projectId,
      state: f.s.state.sha256,
      digests: [],
      all: true,
      select: async () => {
        if (++selections === 2) bind(f, pin);
        return JSON.parse(
          await f.ctx.runMutation(makeFunctionReference('projectStateSourceSelection:runner'), {
            ...f.input,
            state: f.s.state.sha256,
          }),
        );
      },
      catalog: async () => {
        catalog++;
        assert.fail('a current authoritative root supplies the bindings');
      },
      log: () => {},
    });
    assert.equal(value.plan.pin.sha256, pin.sha256);
    assert.equal(selections, 3);
    assert.equal(catalog, 0);
  });
test('a second rebind during the one replacement read refuses the reply without a catalog substitution', async t => {
  const f = await physicalStateSourceFixture(t, 20),
    first = replacement(f),
    second = replacement(f, true);
  let selections = 0;
  await assert.rejects(
    stateSourceGrants({
      projectId: f.s.projectId,
      state: f.s.state.sha256,
      digests: [],
      all: true,
      select: async () => {
        selections++;
        if (selections === 2) bind(f, first);
        if (selections === 3) bind(f, second);
        return JSON.parse(
          await f.ctx.runMutation(makeFunctionReference('projectStateSourceSelection:runner'), {
            ...f.input,
            state: f.s.state.sha256,
          }),
        );
      },
      catalog: async () => assert.fail('no catalog substitution'),
      log: () => {},
    }),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
  assert.equal(selections, 3);
});
test('access withdrawn while following a replacement root prevents the grant reply', async t => {
  const f = await physicalStateSourceFixture(t, 20),
    pin = replacement(f);
  let selections = 0;
  await assert.rejects(
    stateSourceGrants({
      projectId: f.s.projectId,
      state: f.s.state.sha256,
      digests: [],
      all: true,
      select: async () => {
        selections++;
        if (selections === 2) bind(f, pin);
        if (selections === 3) f.s.patch('hostedProjects', f.s.projectId, { owner: 'other-owner' });
        return JSON.parse(
          await f.ctx.runMutation(makeFunctionReference('projectStateSourceSelection:runner'), {
            ...f.input,
            state: f.s.state.sha256,
          }),
        );
      },
      catalog: async () => assert.fail('no catalog substitution'),
      log: () => {},
    }),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(selections, 3);
});
test('Actions materialization refreshes an old bootstrap pin once and verifies every file without catalog fallback', async t => {
  const { ActionsJobClient } = await import('../dist/hosted-actions-job-client.js');
  const { hostedActionsCapabilities } = await import('../dist/hosted-actions-capabilities.js');
  const { materializeActionsSource } = await import('../dist/hosted-actions-job-source.js');
  const { temporaryDirectory } = await import('../scripts/test-temp.mjs');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = await physicalStateSourceFixture(t, 1001),
    pin = replacement(f),
    root = temporaryDirectory(t, 'forge-refresh-actions-'),
    cache = join(root, 'objects');
  mkdirSync(cache);
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, (url, init) =>
    fetch(url, init),
  );
  client.run = f.run;
  client.capabilities = [...hostedActionsCapabilities];
  const commands = [];
  t.mock.method(client, 'call', async command => {
    commands.push(command);
    assert(!command.fallback);
    if (command.state) return expandSourceGrants(await f.source(command));
    const value = await f.heads();
    if (commands.length === 1) bind(f, pin);
    return value;
  });
  await materializeActionsSource(client, join(root, 'candidate'), cache);
  assert.equal(commands.length, 4, 'bootstrap,old-pin plan,fresh bootstrap,fresh plan');
  for (const [i, file] of f.files.entries())
    assert.equal(readFileSync(join(root, 'candidate', file.path), 'utf8'), `source ${i}`);
});
test('clone refreshes a root replaced during transfer and checks all members with no catalog request', async t => {
  const { HostedCheckoutDownloads } = await import('../dist/hosted-checkout-downloads.js');
  const api = await import(moduleUrl('../convex/projectStateSourceApi.ts'));
  const downloadsApi = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
  const f = await physicalStateSourceFixture(t, 1001),
    pin = replacement(f);
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', row._id, { r2Key: `v1/p/${f.s.projectId}/o/${row.digest}` });
  let actions = 0,
    descriptions = 0;
  const downloads = new HostedCheckoutDownloads({
    projectId: f.s.projectId,
    sourceStateReads: true,
    sourceStateVersion: 2,
    client: {
      action: async (_ref, args) => {
        assert.equal(args.version, 2);
        assert(!args.fallback);
        const value = await api.read._handler(f.ctx, args);
        if (++actions === 1) {
          bind(f, pin);
          f.r2.objects.delete(`/synthetic/v1/p/${f.s.projectId}/o/${f.root.pin.sha256}`);
        }
        return value;
      },
      mutation: async (_ref, args) => {
        descriptions++;
        assert.equal(args.stateSource, 2);
        return f.s.transaction('refresh-bootstrap', downloadsApi.describe, args);
      },
    },
  });
  await downloads.objects([f.s.state.sha256]);
  downloads.selectState(f.s.state.sha256, f.files);
  const pins = await downloads.prepareObjects(f.files.map(file => file.blob));
  assert.equal(pins.length, 1001);
  assert.equal(actions, 2);
  assert.equal(descriptions, 2);
  assert.deepEqual(pins.map(pin => pin.sha256).sort(), f.files.map(file => file.blob).sort());
});
