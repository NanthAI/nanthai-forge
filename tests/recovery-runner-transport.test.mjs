// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import { runnerRecoveryTransport } from '../dist/recovery-runner-transport.js';

test('Route B uses authority-selected hosted reads and only ordinary runner registration', async t => {
  const old = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-route-b-token';
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = old;
  });
  const calls = [],
    operationId = randomUUID(),
    authority = { mode: 'server', epoch: 3 };
  const main = {
    schema: 2,
    projectId: 'project',
    snapshotId: 'snapshot',
    sourceRevision: 5,
    authority,
    channel: 'main',
    head: 'a'.repeat(64),
    receipt: { id: 'receipt', kind: 'server', previousHead: 'b'.repeat(64), previousReceiptId: 'previous' },
  };
  const configuration = {
    provider: 'mac',
    machineId: randomUUID(),
    runtime: 'c'.repeat(64),
    environmentFingerprint: 'd'.repeat(64),
  };
  t.mock.method(ConvexHttpClient.prototype, 'query', async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    assert.equal(args.projectId, 'project');
    if (name === 'projectRecovery:prepare') return JSON.stringify({ selection: null, receipt: null });
    if (name === 'projectHostedAgent:capabilities') return JSON.stringify({ authority });
    if (name === 'projectHostedChannels:current') return JSON.stringify(main);
    if (name === 'projectHostedCheckDefinitions:current') return JSON.stringify({ configuration });
    assert.fail(`Unexpected query ${name}`);
  });
  t.mock.method(ConvexHttpClient.prototype, 'mutation', async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    assert.equal(name, 'projectHostedCheckWorker:register');
    return JSON.stringify({ status: 'completed', result: { sessionId: operationId } });
  });
  const transport = runnerRecoveryTransport({
    operationId,
    projectId: 'project',
    url: 'https://synthetic.convex.cloud',
  });
  await transport.prepare();
  assert.deepEqual(await transport.current(), main);
  assert.deepEqual(await transport.configuration(), configuration);
  const request = { operationId, authorityEpoch: 3, configuration };
  await transport.register(request);
  assert.deepEqual(JSON.parse(calls.at(-1).args.request), request);
  assert.equal(
    typeof transport.reconnect,
    'function',
    'Native mode keeps the legacy transport; Route B never invokes its reconnect mutation.',
  );
  assert(!calls.some(call => call.name.startsWith('projectMain:')));
});

test('opaque source recovery streams a large blob without reading it into a Buffer', async t => {
  const { mkdtempSync, mkdirSync, rmSync, openSync, writeSync, closeSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { NativeSource } = await import('../dist/native-source.js');
  const { RecoveryObjects } = await import('../dist/recovery-hosted-objects.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-route-b-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'cache'),
    receipts = join(directory, 'receipts');
  mkdirSync(root);
  mkdirSync(receipts);
  const block = Buffer.alloc(64 * 1024, 97),
    hash = createHash('sha256');
  for (let i = 0; i < 80; i++) hash.update(block);
  const pin = { sha256: hash.digest('hex'), size: block.length * 80 };
  let streamed = 0;
  const source = new NativeSource(root),
    transport = {
      download: async () => assert.fail('Opaque blobs must stream'),
      downloadToFile: async (_pin, path) => {
        streamed++;
        const fd = openSync(path, 'wx', 0o600);
        try {
          for (let i = 0; i < 80; i++) writeSync(fd, block);
        } finally {
          closeSync(fd);
        }
      },
    };
  const object = source.object.bind(source);
  source.object = id => {
    assert.notEqual(id, pin.sha256, 'Opaque source is never loaded as metadata');
    return object(id);
  };
  const cache = new RecoveryObjects(source, receipts, transport);
  const retained = await cache.retain(pin, false, false);
  assert.deepEqual(await cache.retain(pin, false, false), retained);
  assert.equal(streamed, 1);
});
