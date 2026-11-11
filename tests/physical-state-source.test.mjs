// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
const { makeFunctionReference } = await import('convex/server');
test('full29k State signer includes fresh run authority and stays under100KB DB/reply in three resolver mutations', async t => {
  const f = await physicalStateSourceFixture(t, 29000),
    start = f.s.counts.length;
  const heads = await f.heads();
  assert.equal(heads.physical.pin.sha256, f.root.pin.sha256);
  const wire = await f.source({ state: f.s.state.sha256, digests: [f.s.state.sha256], all: true }),
    result = expandSourceGrants(wire);
  assert.equal(result.mode, 'runs');
  assert.equal(result.runs.length, 29);
  assert.equal(f.calls.length, 3, 'head resolve plus State selection before and after R2 IO');
  const dbBytes = f.s.counts.slice(start).reduce((sum, row) => sum + row.readBytes, 0),
    replyBytes = Buffer.byteLength(JSON.stringify(heads)) + Buffer.byteLength(JSON.stringify(wire));
  assert(dbBytes < 100000, `${dbBytes} DB bytes`);
  assert(replyBytes < 100000, `${replyBytes} reply bytes`);
  const other = f.s.put('stored history object outside selected State');
  await assert.rejects(
    f.source({ state: f.s.state.sha256, digests: [other.sha256] }),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
  await assert.rejects(
    f.ctx.runMutation(makeFunctionReference('projectStateSourceSelection:runner'), {
      ...f.input,
      state: digest('unselected State'),
    }),
    error => (error.data?.code ?? error.code) === 'SOURCE_UNAVAILABLE',
  );
  t.diagnostic(
    JSON.stringify({
      files: 29000,
      resolverCalls: 3,
      sourceRequests: 2,
      dbBytes,
      replyBytes,
      fileRuns: result.runs.length,
    }),
  );
});
test('full29k State signer with300 raw changes preserves exact-key grants below100KB including State descriptors', async t => {
  const f = await physicalStateSourceFixture(t, 29000, { rawTail: 300 }),
    start = f.s.counts.length;
  const heads = await f.heads(),
    wire = await f.source({
      state: f.s.state.sha256,
      digests: f.entries.slice(-300).map(entry => entry.sha256),
    });
  const result = expandSourceGrants(wire),
    dbBytes = f.s.counts.slice(start).reduce((sum, row) => sum + row.readBytes, 0),
    replyBytes = Buffer.byteLength(JSON.stringify(heads)) + Buffer.byteLength(JSON.stringify(wire));
  assert.equal(result.rows.length, 300);
  assert.equal(f.calls.length, 3, 'head resolve plus State selection before and after R2 IO');
  assert(dbBytes < 100000);
  assert(replyBytes < 100000, `${replyBytes} reply bytes`);
  t.diagnostic(
    JSON.stringify({
      files: 29000,
      rawChanges: 300,
      resolverCalls: 3,
      sourceRequests: 2,
      dbBytes,
      replyBytes,
    }),
  );
});

test('Actions whole-State reader keeps all5001 members in complete physical runs across3200-object windows', async t => {
  const { ActionsJobClient } = await import('../dist/hosted-actions-job-client.js'),
    { hostedActionsCapabilities, actionsSourceStateCapability } =
      await import('../dist/hosted-actions-capabilities.js'),
    { materializeActionsSource } = await import('../dist/hosted-actions-job-source.js'),
    { temporaryDirectory } = await import('../scripts/test-temp.mjs'),
    { mkdirSync, readFileSync } = await import('node:fs'),
    { join } = await import('node:path');
  const f = await physicalStateSourceFixture(t, 5001),
    root = temporaryDirectory(t, 'forge-state-runs-'),
    cache = join(root, 'objects');
  mkdirSync(cache);
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, (url, init) =>
    fetch(url, init),
  );
  client.run = f.run;
  client.capabilities = [...hostedActionsCapabilities, actionsSourceStateCapability];
  let resolverCalls = 0;
  t.mock.method(client, 'call', async command => {
    assert.equal(command.kind, 'source');
    resolverCalls++;
    if (command.state) return expandSourceGrants(await f.source(command));
    return f.heads();
  });
  await materializeActionsSource(client, join(root, 'candidate'), cache);
  assert.equal(resolverCalls, 2, 'one head grant and one whole-State plan');
  assert.equal(
    f.r2.requests.filter(method => method === 'GET').length,
    11,
    'State, two signer metadata reads, two client metadata reads, and six file packs',
  );
  for (const [index, file] of f.files.entries())
    assert.equal(readFileSync(join(root, 'candidate', file.path), 'utf8'), `source ${index}`);
});

test('clone reader checks current State authority and uses the same complete-run verifier', async t => {
  const { HostedCheckoutDownloads } = await import('../dist/hosted-checkout-downloads.js'),
    { HostedCheckoutCache } = await import('../dist/hosted-checkout-cache.js'),
    { temporaryDirectory } = await import('../scripts/test-temp.mjs'),
    { join } = await import('node:path'),
    { readFileSync } = await import('node:fs');
  const api = await import(moduleUrl('../convex/projectStateSourceApi.ts')),
    objectDownloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
  const f = await physicalStateSourceFixture(t, 1001),
    root = temporaryDirectory(t, 'forge-state-clone-');
  const stateRow = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', stateRow._id, { r2Key: `v1/p/${f.s.projectId}/o/${f.s.state.sha256}` });
  for (const method of ['describe', 'lanePage']) {
    const legacy = await f.s.transaction('legacy-bootstrap-' + method, objectDownloads[method], {
      projectId: f.s.projectId,
      digests: [f.s.state.sha256],
      signed: true,
    });
    assert.equal(legacy[0].statePhysical, undefined, 'old clients receive the original descriptor shape');
    const negotiated = await f.s.transaction('state-bootstrap-' + method, objectDownloads[method], {
      projectId: f.s.projectId,
      digests: [f.s.state.sha256],
      signed: true,
      stateSource: true,
    });
    assert.deepEqual(negotiated[0].statePhysical, f.root.pin);
  }
  const downloads = new HostedCheckoutDownloads({
    projectId: f.s.projectId,
    sourceStateReads: true,
    client: {
      action: async (_ref, args) => api.read._handler(f.ctx, args),
      mutation: async (_ref, args) => {
        assert.deepEqual(args.digests, [f.s.state.sha256], 'only the State bootstrap uses legacy metadata');
        return f.s.transaction('clone-real-bootstrap', objectDownloads.describe, args);
      },
    },
  });
  await downloads.objects([f.s.state.sha256]);
  downloads.selectState(f.s.state.sha256, f.files);
  const cache = new HostedCheckoutCache(
    root,
    downloads.transport({ sourcePack: false }),
    join(root, 'objects'),
    null,
  );
  await cache.ensure(f.files.map(file => file.blob));
  for (const [index, file] of f.files.entries())
    assert.equal(readFileSync(join(root, 'objects', file.blob), 'utf8'), `source ${index}`);
  assert.equal(f.calls.filter(call => call.name === 'projectStateSourceSelection:client').length, 2);
  await assert.rejects(
    api.read._handler(f.ctx, {
      projectId: f.s.projectId,
      state: f.s.state.sha256,
      digests: [digest('outside State')],
    }),
    error => (error.code ?? error.data?.code) === 'SOURCE_UNAVAILABLE',
  );
});

test('an access withdrawal during manifest IO prevents the new grant reply', async t => {
  const f = await physicalStateSourceFixture(t, 1001),
    fetch = globalThis.fetch;
  let withdrew = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await fetch(url, init);
    if (!withdrew && new URL(url).pathname.endsWith(f.root.pin.sha256)) {
      withdrew = true;
      f.s.patch('hostedProjects', f.s.projectId, { owner: 'different-owner' });
    }
    return response;
  });
  await assert.rejects(
    f.source({ state: f.s.state.sha256, digests: [f.s.state.sha256], all: true }),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
  assert(withdrew);
});

for (const fragmented of [false, true])
  test(`one-time${fragmented ? ' fragmented-pack' : ' raw'} window publishes the existing source pack and the following fresh job uses it`, async t => {
    const { ActionsJobClient } = await import('../dist/hosted-actions-job-client.js'),
      { hostedActionsCapabilities, actionsSourceStateCapability } =
        await import('../dist/hosted-actions-capabilities.js'),
      { materializeActionsSource } = await import('../dist/hosted-actions-job-source.js'),
      { createSourcePack } = await import('../dist/source-pack-archive.js'),
      { temporaryDirectory } = await import('../scripts/test-temp.mjs'),
      { mkdirSync, readFileSync } = await import('node:fs'),
      { join } = await import('node:path');
    const { sourcePackCommand } = await import(moduleUrl('../convex/projectSourcePacks.ts')),
      { latestSourcePack } = await import(moduleUrl('../convex/projectSourcePackStore.ts'));
    const f = await physicalStateSourceFixture(
        t,
        3401,
        fragmented ? { fragmented: true } : { rawTail: 3401 },
      ),
      root = temporaryDirectory(t, 'forge-state-window-');
    const make = () => {
      const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, (url, init) =>
        fetch(url, init),
      );
      client.run = f.run;
      client.capabilities = [...hostedActionsCapabilities, actionsSourceStateCapability];
      let calls = 0;
      t.mock.method(client, 'call', async command => {
        assert.equal(command.kind, 'source');
        calls++;
        return command.state ? expandSourceGrants(await f.source(command)) : f.heads();
      });
      return { client, calls: () => calls };
    };
    const first = make(),
      cache = join(root, 'first-objects');
    mkdirSync(cache);
    await materializeActionsSource(first.client, join(root, 'first-tree'), cache);
    assert.equal(first.calls(), 3, 'heads and two bounded file windows, including the all-prefix');
    const state = JSON.parse(f.s.objectBytes.get(f.s.state.sha256)),
      path = join(root, 'source-pack.gz'),
      pack = await createSourcePack(f.s.state.sha256, state, cache, path);
    assert(pack);
    const target = await sourcePackCommand(f.ctx, f.input, 'prepare', pack);
    assert(target);
    await fetch(target.url, { method: 'PUT', headers: target.headers, body: readFileSync(path) });
    await sourcePackCommand(f.ctx, f.input, 'commit', pack);
    const published = await f.s.transaction(
      'physical-latest-pack',
      { _handler: ctx => latestSourcePack(ctx, f.s.projectId) },
      {},
    );
    assert.equal(published.stateRef, f.s.state.sha256);
    const second = make(),
      nextCache = join(root, 'next-objects');
    mkdirSync(nextCache);
    second.client.sourcePack = published;
    await materializeActionsSource(second.client, join(root, 'next-tree'), nextCache);
    assert.equal(second.calls(), 1, 'following fresh job needs only the State grant and the source pack');
    for (const [index, file] of f.files.entries())
      assert.equal(readFileSync(join(root, 'next-tree', file.path), 'utf8'), `source ${index}`);
  });

test('client State selection refuses an ordinary uploaded JSON blob posing as an unregistered State', async t => {
  const f = await physicalStateSourceFixture(t, 1),
    api = await import(moduleUrl('../convex/projectStateSourceApi.ts')),
    forged = f.s.put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: f.files,
        message: 'ordinary file, never registered as source',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
  const before = f.r2.requests.length;
  await assert.rejects(
    api.read._handler(f.ctx, { projectId: f.s.projectId, state: forged.sha256, digests: [f.files[0].blob] }),
    error => (error.data?.code ?? error.code) === 'SOURCE_UNAVAILABLE',
  );
  assert.equal(f.r2.requests.length, before, 'unregistered source never reaches R2');
});

test('a reader with the new capability keeps the legacy file path when the State has no physical manifest', async t => {
  const { ActionsJobClient } = await import('../dist/hosted-actions-job-client.js'),
    { hostedActionsCapabilities, actionsSourceStateCapability } =
      await import('../dist/hosted-actions-capabilities.js'),
    { materializeActionsSource } = await import('../dist/hosted-actions-job-source.js'),
    { temporaryDirectory } = await import('../scripts/test-temp.mjs'),
    { mkdirSync } = await import('node:fs'),
    { join } = await import('node:path');
  const f = await physicalStateSourceFixture(t, 1001, { rawTail: 1001 });
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', row._id, { statePhysical: undefined });
  const root = temporaryDirectory(t, 'forge-state-legacy-'),
    cache = join(root, 'objects');
  mkdirSync(cache);
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, (url, init) =>
    fetch(url, init),
  );
  client.run = f.run;
  client.capabilities = [...hostedActionsCapabilities, actionsSourceStateCapability];
  t.mock.method(client, 'call', async command => {
    assert.equal(command.kind, 'source');
    if (command.bound) return f.heads();
    assert.equal(command.state, undefined, 'legacy files do not become State identifiers');
    return JSON.parse(
      await f.ctx.runMutation(makeFunctionReference('projectHostedActionsSource:resolve'), {
        ...f.input,
        digests: command.digests,
        batch: true,
        ...(command.runs ? { runs: true } : {}),
      }),
    );
  });
  await materializeActionsSource(client, join(root, 'candidate'), cache);
  assert.equal(f.calls.length, 2);
});
