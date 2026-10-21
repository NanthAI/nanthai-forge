// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { exchangeFetch, exchangeRequest } from '../dist/exchange-request.js';
import { exchangeConvexFetch } from '../dist/exchange-convex-fetch.js';
import { ForgeError } from '../dist/errors.js';
import { getSigned } from '../dist/exchange-r2-read.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { digest } from '../dist/hash.js';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';

const deadlines = { headerTimeoutMs: 150, idleTimeoutMs: 150, totalTimeoutMs: 2000, retries: 1, delayMs: 5 };
async function fixture(t, handler) {
  const requests = [],
    sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    handler(req, res, requests.length);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const timedOut = (call, reason) => error => {
  assert(error instanceof ForgeError);
  assert.equal(error.code, 'EXCHANGE_REQUEST_TIMEOUT');
  assert.match(error.message, new RegExp(call));
  assert.match(error.message, new RegExp(reason));
  assert.match(error.message, /attempt 2\/2/);
  assert.doesNotMatch(error.message, /secret|127\.0\.0\.1/);
  return true;
};

test('accepted HTTP connections that never return headers time out, abort and retry finitely', async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(
    exchangeFetch('manifest', `${f.url}/?token=secret`, {}, deadlines),
    timedOut('manifest', 'response headers'),
  );
  assert.equal(f.requests.length, 2);
});

test('half a body then no progress times out and retries the complete read', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': 8 });
    res.write('half');
  });
  const progress = [];
  await assert.rejects(
    exchangeFetch(
      'work.json download',
      f.url,
      {},
      { ...deadlines, onBytes: (done, total) => progress.push([done, total]) },
    ),
    timedOut('work.json', 'body idle'),
  );
  assert.equal(f.requests.length, 2);
  assert.deepEqual(progress, [
    [0, 8],
    [4, 8],
    [0, 8],
    [4, 8],
  ]);
});

test('continuous body progress resets idle time but cannot evade the total cap', async t => {
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write('x');
    const timer = setInterval(() => res.write('x'), 20);
    timers.push(timer);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(
    exchangeFetch('stream', f.url, {}, { ...deadlines, totalTimeoutMs: 300 }),
    timedOut('stream', 'total request'),
  );
  assert.equal(f.requests.length, 2);
});

test('stalled response retry discards partial bytes and returns only a complete successful body', async t => {
  const f = await fixture(t, (_req, res, n) => {
    res.writeHead(200, { 'Content-Length': 8 });
    if (n === 1) res.write('bad!');
    else res.end('complete');
  });
  const response = await exchangeFetch('download', f.url, {}, deadlines);
  assert.equal(await response.text(), 'complete');
  assert.equal(f.requests.length, 2);
});

test('HTTP retries back off; permission failures and Convex structured errors remain final', async t => {
  for (const status of [403, 429, 503, 560]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status);
      res.end('failure');
    });
    assert.equal((await exchangeFetch('read', f.url, {}, deadlines)).status, status);
    assert.equal(f.requests.length, status === 429 || status === 503 ? 2 : 1);
  }
});

test('Convex journal action uses the same deadline and names its endpoint', async t => {
  const f = await fixture(t, () => {});
  const client = new ConvexHttpClient(f.url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: exchangeConvexFetch(deadlines),
  });
  await assert.rejects(
    client.action(makeFunctionReference('projectWorkActions:exportJournal'), { projectId: 'synthetic' }),
    timedOut('projectWorkActions:exportJournal', 'response headers'),
  );
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body, f.requests[1].body);
});

test('receipt-reconciled Convex actions retry identical operation IDs; unknown actions do not replay', async t => {
  const f = await fixture(t, (_req, res, n) => {
    if (n === 1) return res.destroy();
    res.end(JSON.stringify({ status: 'success', value: 'receipt' }));
  });
  const client = new ConvexHttpClient(f.url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: exchangeConvexFetch(deadlines),
  });
  assert.equal(
    await client.action(makeFunctionReference('projectSourceReturn:returnSource'), {
      projectId: 'synthetic',
      operationId: 'same-original-id',
    }),
    'receipt',
  );
  assert.equal(f.requests[0].body, f.requests[1].body);
  const g = await fixture(t, () => {});
  await assert.rejects(
    exchangeConvexFetch(deadlines)(`${g.url}/api/action`, {
      method: 'POST',
      body: JSON.stringify({ path: 'unknown:write', args: [{}] }),
    }),
    error => error.code === 'EXCHANGE_REQUEST_TIMEOUT' && /attempt 1\/1/.test(error.message),
  );
  assert.equal(g.requests.length, 1);
});

test('Convex typed action errors preserve authorization/CAS codes rather than transport retrying', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(560);
    res.end(
      JSON.stringify({
        status: 'error',
        errorData: { code: 'WORK_STALE', message: 'Pinned revision changed' },
        errorMessage: 'Pinned revision changed',
      }),
    );
  });
  const client = new ConvexHttpClient(f.url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: exchangeConvexFetch(deadlines),
  });
  await assert.rejects(
    client.action(makeFunctionReference('projectSourceReturn:returnSource'), { operationId: 'original' }),
    error => error.data?.code === 'WORK_STALE',
  );
  assert.equal(f.requests.length, 1);
});

test('range consumers can cancel a range-less response without buffering its suffix', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write('range');
  });
  const bytes = await exchangeRequest(
    'archive range',
    f.url,
    {},
    async (response, progressed) => {
      const reader = response.body.getReader();
      try {
        const part = await reader.read();
        progressed();
        return Buffer.from(part.value);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
    deadlines,
  );
  assert.equal(bytes.toString(), 'range');
  assert.equal(f.requests.length, 1);
});

test('metadata-tree manifest resolution reports logical work.json bytes through completion', async () => {
  const work = Buffer.from(
    JSON.stringify({
      schema: 15,
      revision: 0,
      notes: Array.from({ length: 300 }, (_, i) => `${i} retained synthetic bytes`),
    }),
  );
  const pin = { sha256: digest(work), size: work.length };
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-native-work-backup',
      id: '00000000-0000-4000-8000-000000000001',
      head: 'a'.repeat(64),
      revision: 0,
      files: [{ path: 'work.json', ...pin }],
      unavailable: [],
      coverage: 'Synthetic',
    }),
  );
  const built = buildExchangeRoot(manifest, work),
    progress = [];
  const exchange = new ConvexExchange(
    'https://example.convex.cloud',
    'synthetic',
    'project',
    'operation',
    null,
  );
  exchange.client = {
    action: async () => ({
      json: built.bytes.toString(),
      digest: digest(built.bytes),
      size: built.bytes.length,
    }),
  };
  exchange.downloadBatch = async pins => pins.map(pin => built.objects.get(pin.sha256));
  exchange.onWorkProgress = (done, total) => progress.push([done, total]);
  await exchange.manifest('backup');
  assert.deepEqual(progress[0], [0, work.length]);
  assert.deepEqual(progress.at(-1), [work.length, work.length]);
  assert(
    progress.every(([done, total], i) => total === work.length && (i === 0 || done >= progress[i - 1][0])),
  );
});

test('reconcile progress identifies manifest, work.json bytes, journal export and local merge', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { initNative } = await import('../dist/native-work.js');
  const { WorkStore } = await import('../dist/work-store.js');
  const { reconcileExchange } = await import('../dist/exchange-reconcile.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-reconcile-progress-'));
  initNative(root);
  const methods = ['manifest', 'download', 'journal', 'journalPage'];
  const saved = methods.map(name => ConvexExchange.prototype[name]);
  const token = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic';
  t.after(() => {
    methods.forEach((name, i) => {
      ConvexExchange.prototype[name] = saved[i];
    });
    if (token === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = token;
    rmSync(root, { recursive: true, force: true });
  });
  const work = Buffer.from('{}'),
    file = { path: 'work.json', sha256: digest(work), size: work.length };
  const manifest = JSON.stringify({
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head: 'a'.repeat(64),
    revision: 0,
    files: [file],
    unavailable: [],
    coverage: 'Synthetic',
  });
  ConvexExchange.prototype.journalPage = async () => {
    throw new ForgeError('JOURNAL_PAGING_UNAVAILABLE', 'Synthetic old server');
  };
  ConvexExchange.prototype.manifest = async function () {
    this.onCall?.('projectExchangeActions:checkpoint', true);
    this.onCall?.('projectExchangeActions:checkpoint', false);
    return { json: manifest, digest: digest(manifest), size: Buffer.byteLength(manifest) };
  };
  ConvexExchange.prototype.download = async function () {
    this.onDownloadProgress?.(file, 1);
    return work;
  };
  ConvexExchange.prototype.journal = async function () {
    this.onCall?.('projectWorkActions:exportJournal', true);
    this.onCall?.('projectWorkActions:exportJournal', false);
    return JSON.stringify({
      source: { backupId: 'synthetic' },
      base: { archiveSha256: digest(manifest) },
      projectKey: 'synthetic',
    });
  };
  const progress = [];
  // Deliberately stop on invalid synthetic journal validation after entering local merge.
  await assert.rejects(
    reconcileExchange(
      root,
      {
        url: 'https://example.convex.cloud',
        projectId: 'synthetic',
        backupId: 'synthetic',
        operationId: randomUUID(),
        revision: new WorkStore(root).revision(),
      },
      { onProgress: text => progress.push(text) },
    ),
  );
  assert(progress.includes('manifest; waiting on projectExchangeActions:checkpoint'));
  assert(progress.includes('work.json download 1/2 bytes'));
  assert(progress.includes('journal export; waiting on projectWorkActions:exportJournal'));
  assert(progress.includes('local merge'));
});

test('active call tracking clears completed and timed-out Convex calls', async t => {
  for (const stall of [false, true]) {
    const f = await fixture(t, (_req, res) => {
      if (!stall) res.end('{}');
    });
    const progress = [];
    const response = exchangeConvexFetch(deadlines, (name, pending) => progress.push([name, pending]))(
      `${f.url}/api/action`,
      { method: 'POST', body: JSON.stringify({ path: 'projectWorkActions:exportJournal', args: [{}] }) },
    );
    if (stall) await assert.rejects(response, error => error.code === 'EXCHANGE_REQUEST_TIMEOUT');
    else await response;
    assert.deepEqual(progress, [
      ['projectWorkActions:exportJournal', true],
      ['projectWorkActions:exportJournal', false],
    ]);
  }
});

test('R2 GET tracking names the pending call and clears both successful and failed reads', async t => {
  for (const status of [200, 503]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status);
      res.end('content');
    });
    const progress = [];
    const response = getSigned(f.url, { size: 7, sha256: digest('content') }, 1, undefined, (name, pending) =>
      progress.push([name, pending]),
    );
    if (status === 200) assert.equal((await response).toString(), 'content');
    else await assert.rejects(response, error => error.code === 'R2_READ_FAILED');
    assert.deepEqual(progress, [
      ['R2 object download', true],
      ['R2 object download', false],
    ]);
  }
});

test('long actions keep the full ten-minute header and total budget; quick calls keep short deadlines', async t => {
  const realTimeout = globalThis.setTimeout,
    timers = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    timers.push(ms);
    return realTimeout(fn, ms, ...args);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const fetch = exchangeConvexFetch();
  for (const path of [
    'projectExchangeActions:publish',
    'projectSourceReturn:returnSource',
    'projectWorkActions:exportJournal',
    'projectWorkIndexActions:ensure',
    'projectExchangeActions:manifest',
    'projectExchangeActions:completeHistory',
    'projectObjectRecipes:complete',
    'projectWorkActions:initialize',
    'projectExchangeMigration:migrate',
  ]) {
    timers.length = 0;
    await fetch('https://fixture.invalid/api/action', { body: JSON.stringify({ path, args: [{}] }) });
    assert.deepEqual(timers.slice(0, 2), [600000, 600000], path);
  }
  for (const [api, path] of [
    ['query', 'projectWorkJournal:page'],
    ['mutation', 'projectObjects:prepareBatch'],
    ['action', 'projectExchangeActions:checkpoint'],
    ['action', 'projectExchangeActions:downloadPart'],
  ]) {
    timers.length = 0;
    await fetch(`https://fixture.invalid/api/${api}`, { body: JSON.stringify({ path, args: [{}] }) });
    assert.deepEqual(timers.slice(0, 2), [30000, 120000], path);
  }
});

test('a publish response arriving after the former header deadline is consumed once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release,
    calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Promise(resolve => {
      release = resolve;
    });
  });
  const pending = exchangeConvexFetch()('https://fixture.invalid/api/action', {
    body: JSON.stringify({ path: 'projectExchangeActions:publish', args: [{ operationId: 'original' }] }),
  });
  t.mock.timers.tick(180001);
  release(new Response('receipt'));
  assert.equal(await (await pending).text(), 'receipt');
  assert.equal(calls, 1);
});

test('long actions override the native HTTP header deadline at dispatch; quick calls use the default transport', async t => {
  const dispatched = [];
  t.mock.method(Agent.prototype, 'dispatch', options => {
    dispatched.push(options);
    return true;
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    init.dispatcher?.dispatch({ origin: 'https://fixture.invalid', path: '/', method: 'POST' }, {});
    return new Response('{}');
  });
  const fetch = exchangeConvexFetch();
  await fetch('https://fixture.invalid/api/action', {
    body: JSON.stringify({ path: 'projectExchangeActions:publish', args: [{}] }),
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].headersTimeout, 600000);
  await fetch('https://fixture.invalid/api/query', {
    body: JSON.stringify({ path: 'projectWorkJournal:page', args: [{}] }),
  });
  assert.equal(dispatched.length, 1);
});
