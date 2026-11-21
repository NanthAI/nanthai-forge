// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { getFunctionName, makeFunctionReference } from 'convex/server';
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
function observeRunnerSelections(t, f, before) {
  const runMutation = f.ctx.runMutation,
    selections = [];
  t.mock.method(f.ctx, 'runMutation', async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectStateSourceSelection:runner', 'no catalog substitution');
    const selection = { recheck: args.recheck, signed: false };
    selections.push(selection);
    before(selections.length);
    const reply = await runMutation(ref, args);
    selection.signed = Boolean(JSON.parse(reply).url);
    return reply;
  });
  return selections;
}
for (const missing of [false, true])
  test(`grant planning refreshes a ${missing ? 'missing' : 'readable'} superseded root before using the catalog`, async t => {
    const f = await physicalStateSourceFixture(t, 20),
      pin = replacement(f),
      selections = observeRunnerSelections(t, f, count => {
        if (count === 2) bind(f, pin);
      });
    if (missing) f.r2.objects.delete(`/synthetic/v1/p/${f.s.projectId}/o/${f.root.pin.sha256}`);
    const value = expandSourceGrants(await f.source({ state: f.s.state.sha256, digests: [], all: true }));
    assert.equal(value.plan.pin.sha256, pin.sha256);
    assert.equal(Boolean(selections[1].recheck), !missing, 'a failed read needs a complete descriptor');
    assert.deepEqual(
      selections.map(selection => selection.signed),
      [true, true, false],
    );
  });
for (const changed of ['physical root', 'State size'])
  test(`a changed ${changed} during the replacement read refuses the grant reply`, async t => {
    const f = await physicalStateSourceFixture(t, 20),
      first = replacement(f),
      second = replacement(f, true),
      selections = observeRunnerSelections(t, f, count => {
        if (count === 2) bind(f, first);
        if (count === 3 && changed === 'physical root') bind(f, second);
        if (count === 3 && changed === 'State size') {
          const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
          f.s.patch('projectObjects', row._id, { size: row.size + 1 });
        }
      });
    await assert.rejects(
      f.source({ state: f.s.state.sha256, digests: [], all: true }),
      error => error.code === 'SOURCE_UNAVAILABLE',
    );
    assert(selections[2].recheck);
    assert.deepEqual(
      selections.map(selection => selection.signed),
      [true, true, true],
    );
  });
for (const rebind of [false, true])
  test(`the runner refuses grants when access is withdrawn during a ${rebind ? 'replacement' : 'matching'} root read`, async t => {
    const f = await physicalStateSourceFixture(t, 20),
      pin = replacement(f),
      finalSelection = rebind ? 3 : 2,
      selections = observeRunnerSelections(t, f, count => {
        if (rebind && count === 2) bind(f, pin);
        if (count === finalSelection) f.s.patch('hostedProjects', f.s.projectId, { owner: 'other-owner' });
      });
    await assert.rejects(
      f.source({ state: f.s.state.sha256, digests: [], all: true }),
      error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
    );
    assert.equal(selections.length, finalSelection);
    assert(selections.at(-1).recheck, 'fresh authorization is required even for an exact pin recheck');
    assert.equal(selections.at(-1).signed, false);
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
