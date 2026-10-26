// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { saveFixture, api, jobApi } from './hosted-saves-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { updateHostState } from '../dist/host-binding.js';
import { boundAgentCache } from '../dist/hosted-agent-cache.js';
import { HostedObjectStore } from '../dist/hosted-object-store.js';
import { digest } from '../dist/hash.js';
import { ForgeError } from '../dist/errors.js';

const noNative = () => assert.fail('No native source authority or exchange push/pull/open');
function fixture(t) {
  const f = agentFixture(t);
  mkdirSync(f.root);
  initNative(f.root);
  const store = new WorkStore(f.root);
  updateHostState(store, state => {
    state.binding = {
      projectId: f.address.projectId,
      deployment: f.address.url,
      operationId: randomUUID(),
      projectUrl: 'https://fixture.invalid/project',
      name: 'Fixture',
      visibility: 'private',
      backupId: 'historic-seed',
      autoSync: false,
      sourceAuthority: f.main.authority,
    };
  });
  const start = { action: 'start', operationId: randomUUID(), outcome: 'Hosted cache' };
  const dispatch = command => boundAgentCache(store, command, noNative, f.transport());
  return { ...f, store, start, dispatch };
}

test('a fresh bound Mac starts from hosted main, clones its cache, and never needs exchange publication', async t => {
  const f = fixture(t),
    blob = Buffer.from('hosted source\n');
  f.objects.set(digest(blob), blob);
  const state = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [{ path: 'a.txt', blob: digest(blob), mode: 'file' }],
      message: 'hosted only',
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
  f.objects.set(digest(state), state);
  f.main.head = f.lane.head = digest(state);
  f.lane.base.head = f.main.head;
  f.main.sourceRevision = 17;
  const first = await f.dispatch(f.start);
  const path = first.result.path;
  assert.equal(first.result.head, f.main.head);
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'hosted source\n');
  assert.equal(f.store.select('lanes', f.lane.laneId).head, f.main.head);
  assert(existsSync(join(f.store.directory, 'lane-source-cache/tree/a.txt')));
  const materialization = JSON.parse(readFileSync(join(path, '.forge/materialization.json')));
  assert(['clone', 'copy'].includes(materialization.method));
  const observations = readFileSync(join(f.store.directory, 'self-metrics.jsonl'), 'utf8');
  assert(observations.includes('hosted-cache'));
  assert(observations.includes('"revision":17'));
  writeFileSync(join(path, 'a.txt'), 'later draft');
  const replay = await f.dispatch({ action: 'start', operationId: f.start.operationId });
  assert.equal(replay.result.path, path);
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'later draft');
  assert(!f.calls.some(c => /Exchange|SourceReturn|projectMain:current/.test(c.name)));
  t.diagnostic(
    JSON.stringify({
      metric7: { hostedRevision: 17, materialisedRevision: 17, observedRevisionLag: 0 },
      materialisation: materialization.method,
    }),
  );
});

test('interrupted cold materialisation resumes the same hosted Lane and rejects revoked access', async t => {
  const f = fixture(t);
  f.lose('download');
  await assert.rejects(f.dispatch(f.start), /lost download/);
  assert(!existsSync(f.store.path(f.lane.laneId)));
  const first = await f.dispatch(f.start);
  assert.equal(first.result.laneId, f.lane.laneId);
  assert.equal(f.operations.size, 1);
  f.allow(false);
  await assert.rejects(f.dispatch(f.start), e => e.code === 'PROJECT_UNAVAILABLE');
});

test('object store verifies downloaded bytes, batches cold gets, and puts by current content identity', async t => {
  const f = fixture(t),
    a = Buffer.from('a'),
    b = Buffer.from('b');
  f.objects.set(digest(a), a);
  f.objects.set(digest(b), b);
  const objects = new HostedObjectStore(join(f.store.directory, 'test-objects'), f.exchange);
  assert.deepEqual(await Promise.all([objects.get(digest(a)), objects.get(digest(b))]), [a, b]);
  assert.equal(await objects.put(Buffer.from('put')), digest('put'));
  assert.deepEqual(f.objects.get(digest('put')), Buffer.from('put'));
  f.exchange.downloadBatch = async pins => pins.map(() => Buffer.from('corrupt'));
  await assert.rejects(objects.get(f.main.head), e => e.code === 'INVALID_NATIVE_SOURCE');
});

async function saveSetup(t) {
  const f = fixture(t),
    s = await saveFixture();
  f.address.projectId =
    f.exchange.projectId =
    f.main.projectId =
    f.lane.projectId =
    f.caps.projectId =
      s.projectId;
  f.main.head = f.lane.head = f.lane.base.head = s.baseline.sha256;
  f.lane.laneId = s.laneId;
  for (const [id, bytes] of s.objects) f.objects.set(id, bytes);
  updateHostState(f.store, state => {
    state.binding.projectId = s.projectId;
  });
  const original = f.exchange.client.mutation;
  let loseUpload = false,
    loseCommit = false,
    puts = 0,
    saved;
  const upload = async (pin, bytes) => {
    assert.equal(digest(bytes), pin.sha256);
    s.put(bytes);
    f.objects.set(pin.sha256, bytes);
  };
  f.exchange.missing = async pins => pins.filter(pin => !s.objects.has(pin.sha256)).map(pin => pin.sha256);
  f.exchange.upload = upload;
  f.exchange.uploadFile = async (pin, directory, path) => {
    await upload(pin, readFileSync(join(directory, path)));
    puts++;
    if (loseUpload) {
      loseUpload = false;
      throw new Error('lost R2 PUT reply');
    }
  };
  f.exchange.client.mutation = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectObjectDownloads:describe')
      return args.digests.map(id => ({ digest: id, size: s.objects.get(id).length, location: 'r2' }));
    if (name === 'projectHostedSaves:prepare') return s.call('prepare', api.prepare, args);
    if (name === 'projectHostedSaves:stage') return s.call('stage', api.stage, args);
    if (name === 'projectHostedSaveJobs:submit') {
      saved = { request: { operationId: args.operationId } };
      await s.submit(saved);
      const output = await s.work(saved),
        result = await s.publish(output);
      for (const [id, bytes] of s.objects) f.objects.set(id, bytes);
      const receipt = result.outcome.result;
      Object.assign(f.lane, {
        head: receipt.head,
        version: receipt.version,
        sourceVersion: receipt.sourceVersion,
      });
      if (loseCommit) {
        loseCommit = false;
        throw new Error('lost hosted commit reply');
      }
      return JSON.stringify(result);
    }
    return original(ref, args);
  };
  const query = f.exchange.client.query;
  f.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedSaves:progress'
      ? s.call('progress', api.progress, args)
      : query(ref, args);
  await f.dispatch(f.start);
  return {
    ...f,
    s,
    puts: () => puts,
    lostUpload: () => {
      loseUpload = true;
    },
    lostCommit: () => {
      loseCommit = true;
    },
  };
}

test('bound checkpoint uploads changed objects only and survives lost PUT and CAS replies without recapturing newer drafts', async t => {
  const f = await saveSetup(t),
    path = f.store.path(f.lane.laneId),
    before = f.lane.head;
  writeFileSync(join(path, 'a.txt'), 'first saved edit');
  const command = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: f.lane.laneId,
    message: 'direct hosted save',
  };
  f.lostUpload();
  await assert.rejects(f.dispatch(command), /lost R2 PUT/);
  assert.equal(f.lane.head, before, 'no head references an interrupted upload');
  writeFileSync(join(path, 'a.txt'), 'newer unsaved draft');
  f.lostCommit();
  await assert.rejects(f.dispatch(command), /lost hosted commit/);
  const hosted = f.lane.head;
  assert.notEqual(hosted, before, 'hosted head is durable even before the Mac acknowledges it');
  assert.equal(f.store.select('lanes', f.lane.laneId).head, before);
  const resumed = await boundAgentCache(new WorkStore(f.root), command, noNative, f.transport());
  assert.equal(resumed.result.head, hosted);
  assert.equal(f.store.select('lanes', f.lane.laneId).head, hosted);
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'newer unsaved draft');
  const source = new NativeSource(f.root),
    state = source.state(hosted);
  assert.equal(
    source.object(state.files.find(file => file.path === 'a.txt').blob).toString(),
    'first saved edit',
  );
  assert.equal(f.puts(), 1, 'one changed file uploaded once; unchanged source reused');
  const replay = await f.dispatch({ action: 'checkpoint', operationId: command.operationId });
  assert.equal(replay.result.head, hosted);
  assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 1);
  await assert.rejects(
    f.dispatch({ ...command, message: 'different' }),
    e => e.code === 'WORK_OPERATION_CHANGED',
  );
  assert(!f.calls.some(c => /Exchange|SourceReturn/.test(c.name)));
});

test('hosted CAS preserves a concurrent save; no local checkpoint is published for the loser', async t => {
  const f = await saveSetup(t),
    before = f.lane.head;
  writeFileSync(join(f.store.path(f.lane.laneId), 'a.txt'), 'local edit');
  const mutate = f.exchange.client.mutation;
  f.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSaves:prepare')
      throw new ForgeError('WORK_STALE', 'Concurrent hosted save won CAS');
    return mutate(ref, args);
  };
  await assert.rejects(
    f.dispatch({ action: 'checkpoint', operationId: randomUUID(), laneId: f.lane.laneId, message: 'loser' }),
    e => e.code === 'WORK_STALE',
  );
  assert.equal(f.store.select('lanes', f.lane.laneId).head, before);
  assert.equal(f.store.select('lanes', f.lane.laneId).checkpoints.length, 0);
});

test('explicit workspace source is uploaded and retained instead of silently switching it to hosted main', async t => {
  const f = fixture(t),
    source = new NativeSource(f.root),
    localHead = f.store.load().nativeHead;
  assert.notEqual(localHead, f.main.head);
  const mutation = f.exchange.client.mutation;
  f.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedStart:start') {
      assert.equal(args.initialHead, localHead);
      assert(f.objects.has(localHead), 'selected State uploaded before hosted pointer');
      f.lane.head = args.initialHead;
    }
    return mutation(ref, args);
  };
  const result = await f.dispatch({ ...f.start, channel: null });
  assert.equal(result.result.head, localHead);
  assert.equal(result.result.baseChannel, null);
  assert.deepEqual(source.state(localHead).files, source.capture(result.result.path, false, localHead));
});

test('stacked start keeps the hosted parent head and native dependency metadata', async t => {
  const f = fixture(t),
    parent = { ...f.lane, laneId: randomUUID(), intentId: randomUUID() };
  const query = f.exchange.client.query;
  f.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedLanes:select' && args.laneId === parent.laneId
      ? Promise.resolve(JSON.stringify(parent))
      : query(ref, args);
  const result = await f.dispatch({ ...f.start, stackOn: parent.laneId });
  const lane = f.store.select('lanes', result.result.laneId);
  assert.equal(lane.head, parent.head);
  assert.equal(lane.stack.laneId, parent.laneId);
  assert.deepEqual(lane.after, { intentId: parent.intentId });
});

test('bound CLI and native MCP workflow start and save aliases use the cache route without explicit addressing', async t => {
  const f = fixture(t);
  const { ConvexExchange } = await import('../dist/exchange-client.js');
  const { agentCli } = await import('../dist/agent-cli.js');
  const { AgentWorkflow } = await import('../dist/agent-workflow.js');
  for (const name of [
    'upload',
    'uploadFile',
    'missing',
    'objects',
    'downloadBatch',
    'downloadToFile',
    'prepareDownloads',
  ])
    t.mock.method(ConvexExchange.prototype, name, (...args) => f.exchange[name](...args));
  const prior = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-only';
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = prior;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(f.address.url));
    const { makeFunctionReference } = await import('convex/server');
    const body = JSON.parse(init.body);
    const value = await f.exchange.client[String(url).endsWith('/api/query') ? 'query' : 'mutation'](
      makeFunctionReference(body.path),
      body.args[0],
    );
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const started = await agentCli([f.root, 'start', JSON.stringify(f.start)]);
  assert.equal(started.result.transport, 'hosted');
  const saved = await new AgentWorkflow(f.root, true).dispatch({
    action: 'save',
    operationId: randomUUID(),
    laneId: started.result.laneId,
    message: 'clean hosted checkpoint',
  });
  assert.equal(saved.result.transport, 'hosted');
  assert.equal(saved.result.head, f.main.head);
  assert(!f.calls.some(c => /Exchange|SourceReturn/.test(c.name)));
});

test('pending hosted save leaves both old heads selected and returns without client polling', async t => {
  const f = await saveSetup(t),
    before = f.lane.head;
  writeFileSync(join(f.store.path(f.lane.laneId), 'a.txt'), 'captured first');
  const mutate = f.exchange.client.mutation;
  let pending = true;
  f.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSaveJobs:submit' && pending)
      return JSON.stringify(await f.s.submit({ request: { operationId: args.operationId } }));
    return mutate(ref, args);
  };
  const command = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: f.lane.laneId,
    message: 'pending',
  };
  const response = await f.dispatch(command);
  assert.equal(response.result.status, 'pending');
  assert.equal(response.result.complete, false);
  assert.equal(f.lane.head, before);
  assert.equal(f.store.select('lanes', f.lane.laneId).head, before);
  pending = false;
  writeFileSync(join(f.store.path(f.lane.laneId), 'a.txt'), 'later unsaved');
  const resumed = await f.dispatch(command);
  assert.equal(resumed.result.head, f.lane.head);
  assert.notEqual(resumed.result.head, before);
  assert.equal(readFileSync(join(f.store.path(f.lane.laneId), 'a.txt'), 'utf8'), 'later unsaved');
});

test('a stacked cold-download interruption retains the original parent head after that parent advances', async t => {
  const f = fixture(t),
    original = { ...f.lane, laneId: randomUUID(), intentId: randomUUID() },
    parent = { ...original };
  const query = f.exchange.client.query;
  f.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedLanes:select' && args.laneId === parent.laneId
      ? Promise.resolve(JSON.stringify(parent))
      : query(ref, args);
  f.lose('download');
  const command = { ...f.start, stackOn: parent.laneId };
  await assert.rejects(f.dispatch(command), /lost download/);
  parent.head = 'f'.repeat(64);
  const resumed = await f.dispatch(command);
  assert.equal(resumed.result.head, original.head);
  assert.equal(f.store.select('lanes', resumed.result.laneId).stack.startHead, original.head);
});
