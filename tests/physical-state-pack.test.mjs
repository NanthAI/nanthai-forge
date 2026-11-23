// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { digest } from '../dist/hash.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { moduleUrl } from './convex-module.mjs';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import {
  hostedActionsCapabilities,
  actionsSourceStateCapability,
} from '../dist/hosted-actions-capabilities.js';
import { materializeActionsSource } from '../dist/hosted-actions-job-source.js';
import { refreshActionsPackArtifact } from '../dist/hosted-actions-job-pack.js';
import { prepareActionsJob } from '../dist/hosted-actions-job-plan.js';
import { sourcePackKey } from '../dist/source-pack.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const { sourcePackCommand } = await import(moduleUrl('../convex/projectSourcePacks.ts'));
const { writableHostedCheck, writeHostedCheck } = await import(
  moduleUrl('../convex/projectHostedCheckStore.ts')
);
test('pack refresh selects the accepted base for a file the Candidate changed instead of denying it as a Candidate nonmember', async t => {
  const f = await physicalStateSourceFixture(t, 10, { protocol: 2 }),
    oldBytes = Buffer.from('old source'),
    oldBlob = f.s.put(oldBytes),
    baseFiles = f.files.map((file, index) => (index ? file : { ...file, blob: oldBlob.sha256 })),
    baseBytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: baseFiles,
        message: 'accepted base',
        at: '2026-01-01T00:00:00.000Z',
      }),
    ),
    base = f.s.put(baseBytes);
  const store = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    f.r2.objects.set(`/synthetic/v1/p/${f.s.projectId}/o/${pin.sha256}`, bytes);
    return pin;
  };
  const entries = new Map(f.entries.map(entry => [entry.sha256, entry]));
  entries.set(oldBlob.sha256, oldBlob);
  const root = await writePhysicalManifest({
    state: base.sha256,
    members: baseFiles.map(file => file.blob),
    parent: null,
    describe: async ids => ids.map(id => entries.get(id)),
    put: store,
  });
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === base.sha256);
  f.s.patch('projectObjects', row._id, { statePhysical: root.pin, stateGeneration: 4 });
  for (const [id, bytes] of [
    [oldBlob.sha256, oldBytes],
    [base.sha256, baseBytes],
  ]) {
    f.r2.objects.set(`/synthetic/v1/p/${f.s.projectId}/o/${id}`, bytes);
    f.r2.objects.set(`/synthetic/synthetic/${id}`, bytes);
  }
  f.run.candidate.base.head = base.sha256;
  await f.s.transaction(
    'physical-pin-accepted-base',
    {
      _handler: async ctx => {
        const selected = await writableHostedCheck(ctx, f.input);
        selected.run.candidate.base.head = base.sha256;
        await writeHostedCheck(ctx, selected.row._id, selected.run);
      },
    },
    {},
  );
  const directory = temporaryDirectory(t, 'forge-state-base-pack-'),
    cache = join(directory, 'objects');
  mkdirSync(cache);
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, async (url, init) => {
    if (init?.method === 'PUT') {
      const parts = [];
      for await (const bytes of init.body) parts.push(bytes);
      return fetch(url, { ...init, body: Buffer.concat(parts) });
    }
    return fetch(url, init);
  });
  const planRun = { ...f.run, check: { ...f.run.check, args: ['verify-source.mjs'] } };
  client.run = planRun;
  client.capabilities = [...hostedActionsCapabilities, actionsSourceStateCapability];
  t.mock.method(client, 'session', async () => planRun);
  const call = async command => {
    if (command.kind === 'source') {
      if (command.state) return expandSourceGrants(await f.source(command));
      if (command.bound) return f.heads();
      return f.ctx.runMutation(makeFunctionReference('projectHostedActionsSource:resolve'), {
        ...f.input,
        digests: command.digests,
        version: 2,
      });
    }
    if (command.kind === 'plan') return planRun;
    assert.equal(command.kind, 'sourcePack');
    return sourcePackCommand(f.ctx, f.input, command.phase, command.object);
  };
  t.mock.method(client, 'call', call);
  const candidate = join(directory, 'candidate');
  const plan = await prepareActionsJob(client, candidate, cache);
  assert.equal(plan.packRefresh.refresh, true);
  const artifactPath = join(directory, 'forge-pack-refresh.json');
  writeFileSync(artifactPath, JSON.stringify(plan.packRefresh));
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const refreshCache = join(directory, 'pack-job-objects');
  const refreshClient = new ActionsJobClient(client.site, f.s.projectId, f.run.id, client.request);
  refreshClient.run = f.run;
  refreshClient.capabilities = client.capabilities;
  t.mock.method(refreshClient, 'call', call);
  const refresh = source => refreshActionsPackArtifact(refreshClient, source, candidate, refreshCache);
  const skips = [];
  const originalLog = console.log;
  const log = t.mock.method(console, 'log', (...args) => {
    if (args[0].startsWith('source pack: refresh skipped')) skips.push(args.join(' '));
    else originalLog(...args);
  });
  const failedCalls = f.calls.length;
  const failedRequests = f.r2.requests.length;
  const { requiresStateBinding, ...oldArtifact } = artifact;
  assert.equal(await refresh(oldArtifact), false);
  assert.deepEqual(skips, ['source pack: refresh skipped (base-source-unavailable)']);
  assert.deepEqual(
    f.calls.slice(failedCalls).map(call => call.name),
    ['projectHostedActionsSource:resolve'],
  );
  assert.equal(f.r2.requests.length, failedRequests);
  log.mock.restore();

  assert.equal(requiresStateBinding, true);
  const calls = f.calls.length;
  const requests = f.r2.requests.length;
  assert.equal(await refresh(artifact), true);
  const refreshCalls = f.calls.slice(calls);
  assert.equal(refreshCalls[0].args.state, base.sha256);
  assert.deepEqual(
    refreshCalls.map(call => call.name),
    [
      'projectStateSourceSelection:runner',
      'projectStateSourceSelection:runner',
      'projectSourcePacks:prepare',
      'projectHostedActionsSession:session',
      'projectSourcePacks:commit',
    ],
  );
  const refreshRequests = f.r2.requests.slice(requests);
  assert.deepEqual(refreshRequests, ['GET', 'GET', 'GET', 'PUT', 'HEAD']);
  t.diagnostic(JSON.stringify({ refreshMutations: refreshCalls.length, r2: refreshRequests }));
  const published = [...f.s.tables.projectSourcePacks.values()][0].latest;
  assert.equal(published.stateRef, base.sha256);
  assert.equal(published.stateGeneration, 4);
});

test('a delayed check on an older accepted State cannot replace a newer source pack', async t => {
  const f = await physicalStateSourceFixture(t, 1);
  const older = f.run.candidate.base.head;
  const state = [...f.s.tables.projectObjects.values()].find(row => row.digest === older);
  f.s.patch('projectObjects', state._id, { stateGeneration: 4 });
  const stateRef = digest('newer accepted state');
  const sha256 = digest('newer source pack');
  const latest = {
    stateRef,
    sha256,
    objectKey: sourcePackKey(f.s.projectId, stateRef, sha256),
    stateGeneration: 5,
    size: 10,
    fileCount: 1,
    createdAt: 1,
    expiresAt: 2,
  };
  const row = f.s.insert('projectSourcePacks', { projectId: f.s.projectId, latest });
  const requests = f.r2.requests.length;
  assert.equal(
    await sourcePackCommand(f.ctx, f.input, 'prepare', {
      stateRef: older,
      sha256: digest('older source pack'),
      size: 10,
      fileCount: 1,
    }),
    null,
  );
  assert.deepEqual(f.s.tables.projectSourcePacks.get(row).latest, latest);
  assert.equal(f.s.tables.projectSourcePacks.get(row).other, undefined);
  assert.equal(f.r2.requests.length, requests);
});

test('a cold29k job with a historical source pack and300 raw changes stays under100KB and three resolver mutations', async t => {
  const { createSourcePack } = await import('../dist/source-pack-archive.js'),
    { latestSourcePack } = await import(moduleUrl('../convex/projectSourcePackStore.ts'));
  const f = await physicalStateSourceFixture(t, 29000, { rawTail: 300 }),
    directory = temporaryDirectory(t, 'forge-state-delta-pack-'),
    seedCache = join(directory, 'seed-objects');
  mkdirSync(seedCache);
  const state = JSON.parse(f.s.objectBytes.get(f.s.state.sha256)),
    historical = { ...state, files: f.files.slice(0, -300), message: 'historical packed source' },
    stateBytes = Buffer.from(JSON.stringify(historical)),
    packState = f.s.put(stateBytes);
  f.r2.objects.set(`/synthetic/v1/p/${f.s.projectId}/o/${packState.sha256}`, stateBytes);
  f.r2.objects.set(`/synthetic/synthetic/${packState.sha256}`, stateBytes);
  for (const [index, file] of historical.files.entries())
    writeFileSync(join(seedCache, file.blob), `source ${index}`);
  const setBase = async head => {
    f.run.candidate.base.head = head;
    await f.s.transaction(
      'physical-historical-pack-base',
      {
        _handler: async ctx => {
          const selected = await writableHostedCheck(ctx, f.input);
          selected.run.candidate.base.head = head;
          await writeHostedCheck(ctx, selected.row._id, selected.run);
        },
      },
      {},
    );
  };
  await setBase(packState.sha256);
  const archive = join(directory, 'historical.gz'),
    upload = await createSourcePack(packState.sha256, historical, seedCache, archive);
  assert(upload);
  const target = await sourcePackCommand(f.ctx, f.input, 'prepare', upload);
  assert(target);
  await fetch(target.url, { method: 'PUT', headers: target.headers, body: readFileSync(archive) });
  await sourcePackCommand(f.ctx, f.input, 'commit', upload);
  // A later run's base has advanced: the latest source pack is neither initial head.
  await setBase(f.s.state.sha256);
  const pack = await f.s.transaction(
    'physical-historical-latest-pack',
    {
      _handler: ctx => latestSourcePack(ctx, f.s.projectId),
    },
    {},
  );
  assert.equal(pack.stateRef, packState.sha256);
  const cache = join(directory, 'cold-objects');
  mkdirSync(cache);
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, (url, init) =>
    fetch(url, init),
  );
  client.run = f.run;
  client.sourcePack = pack;
  client.capabilities = [...hostedActionsCapabilities];
  let requests = 0,
    replyBytes = Buffer.byteLength(JSON.stringify(pack));
  const start = f.s.counts.length;
  f.calls.length = 0;
  t.mock.method(client, 'call', async command => {
    assert.equal(command.kind, 'source');
    requests++;
    const wire = command.state ? await f.source(command) : await f.heads();
    replyBytes += Buffer.byteLength(JSON.stringify(wire));
    return expandSourceGrants(wire);
  });
  const source = await materializeActionsSource(client, join(directory, 'candidate'), cache);
  assert(source.packed, 'historical pack supplies the unchanged28700 files');
  assert.equal(source.deltaFiles, 300);
  assert.equal(requests, 2, 'one head request and one Candidate delta request');
  const resolverCalls = f.calls.length;
  assert.equal(resolverCalls, 3, 'head resolver and two fresh State authority selections');
  const dbBytes = f.s.counts.slice(start).reduce((sum, row) => sum + row.readBytes, 0);
  assert(dbBytes < 100000, `${dbBytes} serialized DB bytes`);
  assert(replyBytes < 100000, `${replyBytes} grant reply bytes including signed source pack`);
  for (const [index, file] of f.files.entries())
    assert.equal(readFileSync(join(directory, 'candidate', file.path), 'utf8'), `source ${index}`);

  const heads = await f.heads();
  assert.equal(heads.extraStates, undefined);
  assert.deepEqual(
    heads.rows.map(row => row.descriptor.object.sha256),
    [f.s.state.sha256],
  );
  const r2Requests = f.r2.requests.length;
  await assert.rejects(
    f.ctx.runMutation(makeFunctionReference('projectHostedActionsSource:resolve'), {
      ...f.input,
      digests: [packState.sha256],
      bound: true,
    }),
    error => (error.data?.code ?? error.code) === 'SOURCE_UNAVAILABLE',
  );
  await assert.rejects(
    f.source({ state: packState.sha256, digests: [packState.sha256] }),
    error => (error.data?.code ?? error.code) === 'SOURCE_UNAVAILABLE',
  );
  assert.equal(f.r2.requests.length, r2Requests, 'historical State grants are refused before storage I/O');
  t.diagnostic(
    JSON.stringify({
      files: 29000,
      packedFiles: 28700,
      rawChanges: 300,
      resolverCalls,
      sourceRequests: requests,
      dbBytes,
      replyBytes,
    }),
  );
});
