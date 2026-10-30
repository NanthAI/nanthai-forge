// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { exchangeCommand } from '../dist/exchange-cli.js';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { ConvexLaneTransport } from '../dist/hosted-lane-transport.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const lanes = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const main = await import(moduleUrl('../convex/projectMain.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const metrics = [];
test('full/sparse checkout uses bounded indexed membership/signing with no Work or Channel-history reads', async t => {
  const s = lanesFixture(),
    projectId = s.insert('hostedProjects', {
      key: 'synthetic',
      name: 'Synthetic',
      currentBackup: null,
      revision: 0,
      owner: 'owner',
      visibility: 'private',
      sourceAuthority: { mode: 'server', epoch: 1 },
    });
  const objects = new Map();
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const id = digest(bytes);
    objects.set(id, bytes);
    s.insert('projectObjects', {
      projectId,
      digest: id,
      size: bytes.length,
      nonce: randomUUID(),
      removed: false,
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/${projectId}/o/${id}`,
    });
    return id;
  };
  const files = Array.from({ length: 250 }, (_, i) => ({
    path: `src/${i}.txt`,
    blob: put(`synthetic ${i}`),
    mode: 'file',
  }));
  const head = put(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const selection = {
    schema: 2,
    projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify(selection),
  });
  const begun = JSON.parse(
    await s.call('start', start.start, {
      projectId,
      operationId: randomUUID(),
      authorityEpoch: 1,
      expectedMain: { head, receiptId: 'main-0' },
      intent: { kind: 'new', outcome: 'Synthetic checkout' },
    }),
  );
  const env = {
    R2_ACCOUNT_ID: 'checkout-fixture',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
  };
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  let gets = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'checkout-fixture.r2.cloudflarestorage.com');
    const id = parsed.pathname.split('/').at(-1);
    assert(objects.has(id));
    gets++;
    return new Response(objects.get(id));
  });
  const calls = [];
  let actor = 'owner';
  const run = async (ref, args) => {
    const name = getFunctionName(ref);
    const functions = {
      'projectHostedLanes:select': lanes.select,
      'projectMain:objects': main.objects,
      'projectObjectDownloads:signDownloads': downloads.signDownloads,
      'projectObjectDownloads:describe': downloads.describe,
      'projectObjectDownloads:lanePage': downloads.lanePage,
    };
    assert(functions[name], `Unexpected checkout call: ${name}`);
    assert((args.digests?.length ?? 0) <= 500);
    calls.push({ name, size: args.digests?.length ?? 0 });
    try {
      return await s.call(name, functions[name], args, actor);
    } finally {
      const meter = s.counts.at(-1);
      const max = name === 'projectHostedLanes:select' ? 10 : 505;
      assert(meter.documents <= max && meter.ranges <= max, `${name}: per-function read counts`);
      assert(meter.readBytes < 256 * 1024, `${name}: bounded metadata bytes`);
      assert(
        !meter.touched.some(table =>
          [
            'projectWorkRecords',
            'projectWorkEvents',
            'projectWorkGenerations',
            'projectBackups',
            'projectHostedChannels',
          ].includes(table),
        ),
      );
      metrics.push(meter);
    }
  };
  const exchange = new ConvexExchange(
    'https://fixture.invalid',
    'synthetic-token',
    projectId,
    randomUUID(),
    null,
  );
  exchange.client = { query: run, mutation: run, action: run };
  const transport = new ConvexLaneTransport(exchange),
    directory = mkdtempSync(join(tmpdir(), 'forge-lane-reads-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const request = paths => ({
    url: 'https://fixture.invalid',
    projectId,
    laneId: begun.lane.laneId,
    operationId: randomUUID(),
    ...(paths === undefined ? {} : { paths }),
  });
  const root = join(directory, 'full');
  const full = await checkoutHostedLane(root, request(), transport);
  assert.equal(full.downloadedObjects, 251);
  assert.equal(readFileSync(join(root, 'src/249.txt'), 'utf8'), 'synthetic 249');
  assert.deepEqual(
    calls.filter(call => call.name === 'projectObjectDownloads:lanePage').map(call => call.size),
    [1, 1, 250, 250],
  );
  assert.deepEqual(
    calls.filter(call => call.name === 'projectObjectDownloads:signDownloads').map(call => call.size),
    [],
  );
  const before = { calls: calls.length, gets };
  const warm = await checkoutHostedLane(root, request(), transport);
  assert.equal(warm.downloadedObjects, 0);
  assert.equal(gets, before.gets);
  assert.deepEqual(
    calls.slice(before.calls).map(call => call.name),
    ['projectHostedLanes:select', 'projectHostedLanes:select'],
  );
  const sparse = join(directory, 'sparse');
  const one = await checkoutHostedLane(sparse, request(['src/7.txt']), transport);
  assert.equal(one.downloadedObjects, 2);
  assert.equal(readHostedLaneCheckout(sparse).state.files.length, 250);
  assert.deepEqual(readHostedLaneCheckout(sparse).materialized, ['src/7.txt']);
  const cliRoot = join(directory, 'cli');
  t.mock.method(ConvexHttpClient.prototype, 'query', run);
  t.mock.method(ConvexHttpClient.prototype, 'mutation', run);
  const priorToken = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-token';
  t.after(() => {
    if (priorToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = priorToken;
  });
  const cli = await exchangeCommand(cliRoot, 'open-lane', request(['src/8.txt']));
  assert.equal(cli.head, head);
  assert.equal(readFileSync(join(cliRoot, 'src/8.txt'), 'utf8'), 'synthetic 8');
  const large = [Buffer.alloc(2 * 1024 * 1024 + 17, 0xff), Buffer.alloc(2 * 1024 * 1024 + 19, 0x80)];
  const largeFiles = large.map((bytes, index) => ({
    pin: { sha256: put(bytes), size: bytes.length },
    path: join(directory, `large-${index}.bin`),
  }));
  const beforeLarge = calls.length;
  await transport.downloadFiles(largeFiles);
  assert.deepEqual(
    calls
      .slice(beforeLarge)
      .filter(call => call.name === 'projectObjectDownloads:lanePage')
      .map(call => call.size),
    [2, 2],
  );
  for (let index = 0; index < largeFiles.length; index++)
    assert.deepEqual(readFileSync(largeFiles[index].path), large[index]);
  const reader = s.insert('projectReaders', { projectId, reader: 'reader' });
  actor = 'reader';
  await transport.select(begun.lane.laneId);
  s.tables.projectReaders.delete(reader);
  const denied = error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE';
  await assert.rejects(checkoutHostedLane(root, request(), transport), denied);
  await assert.rejects(transport.objects([head]), denied);
  await assert.rejects(runRef('projectObjectDownloads:signDownloads', [head]), denied);
  actor = 'owner';
  const foreign = digest('foreign-only');
  s.insert('projectObjects', {
    projectId: 'other-project',
    digest: foreign,
    size: 12,
    nonce: randomUUID(),
    removed: false,
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/other-project/o/${foreign}`,
  });
  await assert.rejects(transport.objects([foreign]), error => error.data?.code === 'SOURCE_UNAVAILABLE');
  assert.deepEqual(await runRef('projectObjectDownloads:signDownloads', [foreign]), []);
  async function runRef(name, digests) {
    const { makeFunctionReference } = await import('convex/server');
    return run(makeFunctionReference(name), { projectId, digests });
  }
  t.diagnostic(
    JSON.stringify({
      descriptorWindows: [1, 250],
      postIoWindows: [1, 250],
      fullObjects: full.downloadedObjects,
      sparseObjects: one.downloadedObjects,
      unchangedObjects: warm.downloadedObjects,
    }),
  );
});
test.after(() => {
  const byFunction = {};
  for (const count of metrics) {
    const max = (byFunction[count.name] ??= { ranges: 0, documents: 0, readBytes: 0 });
    for (const key of Object.keys(max)) max[key] = Math.max(max[key], count[key]);
  }
  console.log('H04 fake read-count maxima', JSON.stringify(byFunction));
});
