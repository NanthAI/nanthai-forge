// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkFetch, networkDeadline, networkTimeout } from '../dist/network-fetch.js';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { exchangeConvexFetch } from '../dist/exchange-convex-fetch.js';
import { coordinationClient } from '../dist/coordination-client.js';
import { networkContinuation } from '../dist/network-continuation.js';
import { networkBoundaryFindings } from '../scripts/check-network-boundaries.mjs';
import { makeFunctionReference } from 'convex/server';

const options = { headerTimeoutMs: 40, idleTimeoutMs: 40, totalTimeoutMs: 120, retries: 0, delayMs: 1 };
async function fixture(t, handler) {
  const sockets = new Set(),
    calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    handler(req, res, calls);
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
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}
const timeout = error => error.code === 'EXCHANGE_REQUEST_TIMEOUT';

test('Convex HTTP redirects preserve the existing method and function arguments', async t => {
  const methods = [];
  const f = await fixture(t, (req, res) => {
    methods.push(req.method);
    if (req.url === '/api/query') {
      res.writeHead(307, { location: '/redirected-query' });
      res.end();
    } else res.end(JSON.stringify({ status: 'success', value: 42 }));
  });
  const client = deadlineConvexClient(
    f.url,
    {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: exchangeConvexFetch({
        ...options,
        headerTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        totalTimeoutMs: 2000,
      }),
    },
    3000,
  );
  const value = await client.query(makeFunctionReference('test:redirect'), { operationId: 'original' });
  assert.equal(value, 42);
  assert.deepEqual(methods, ['POST', 'POST']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body, f.calls[1].body);
});

test('a redirect target that never answers retains the same deadline and continuation', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/api/query') {
      res.writeHead(307, { location: '/stalled-query' });
      res.end();
    }
  });
  const client = deadlineConvexClient(
    f.url,
    {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: exchangeConvexFetch({
        ...options,
        headerTimeoutMs: 500,
        idleTimeoutMs: 500,
        totalTimeoutMs: 1000,
      }),
    },
    2000,
  );
  const command = { operationId: '11111111-1111-4111-8111-111111111111', message: 'original input' };
  let failure;
  try {
    await client.query(makeFunctionReference('test:redirect'), command);
  } catch (error) {
    failure = error;
  }
  assert(timeout(failure));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body, f.calls[1].body);
  const pending = networkContinuation(
    '/synthetic/lane',
    { url: f.url, projectId: 'project' },
    'finish',
    command,
    command.operationId,
    failure,
  );
  assert.deepEqual(pending.result.replayParameters, command);
  assert.equal(pending.result.next.operationId, command.operationId);
  assert.equal(pending.result.inProgress, true);
});

test('Convex requests retain an explicitly selected manual redirect policy', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(307, { location: '/caller-selected-target' });
    res.end('caller selected manual redirect');
  });
  const client = deadlineConvexClient(
    f.url,
    {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: exchangeConvexFetch({ ...options, headerTimeoutMs: 1000, totalTimeoutMs: 2000 }),
    },
    3000,
  );
  client.setFetchOptions({ redirect: 'manual' });
  await assert.rejects(
    client.query(makeFunctionReference('test:redirect'), {}),
    /caller selected manual redirect/,
  );
  assert.equal(f.calls.length, 1);
});

test('coordination retains its existing redirect rejection without changing general exchange behavior', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(307, { location: '/must-not-forward' });
    res.end();
  });
  const client = coordinationClient(f.url, 'synthetic-owner-token');
  client.setFetchOptions({ redirect: 'follow' });
  await assert.rejects(client.query(makeFunctionReference('test:redirect'), {}), {
    code: 'EXCHANGE_REQUEST_FAILED',
  });
  assert.equal(f.calls.length, 4); // One read plus its three bounded transport retries.
  assert(f.calls.every(call => call.path === '/api/query'));
});

test('explicit upload deadlines preserve headers beyond the shared default', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release,
    settled = false,
    failure;
  const headers = new Promise(resolve => {
    release = resolve;
  });
  const pending = networkFetch(
    'https://fixture.invalid',
    {
      method: 'PUT',
      signal: networkTimeout(900_000),
      body: 'pinned bytes',
    },
    { request: () => headers },
  ).then(
    response => {
      settled = true;
      return response;
    },
    error => {
      settled = true;
      failure = error;
      return null;
    },
  );
  t.mock.timers.tick(30_001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the existing upload budget must survive the default header deadline');
  release(new Response('complete'));
  const response = await pending;
  assert.equal(failure, undefined);
  assert.equal(await response.text(), 'complete');
});

test('explicit archive deadline preserves a progressing body beyond the shared total default', async t => {
  let now = 0,
    source,
    failure;
  t.mock.method(performance, 'now', () => now);
  const response = await networkFetch(
    'https://fixture.invalid',
    { signal: networkTimeout(480_000) },
    {
      retries: 0,
      request: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              source = controller;
            },
          }),
        ),
    },
  );
  const pending = response.text().catch(error => {
    failure = error;
    return null;
  });
  now = 120_001;
  source.enqueue(new TextEncoder().encode('pinned archive'));
  await new Promise(resolve => setTimeout(resolve, 5));
  if (!failure) source.close();
  const bytes = await pending;
  assert.equal(failure, undefined, 'progress inside the original archive budget must remain readable');
  assert.equal(bytes, 'pinned archive');
});

test('explicit per-request deadlines override a longer caller budget', async () => {
  await assert.rejects(
    networkFetch(
      'https://fixture.invalid',
      { signal: networkTimeout(600_000) },
      {
        ...options,
        totalTimeoutMs: 10,
        headerTimeoutMs: 50,
        request: () => new Promise(() => {}),
      },
    ),
    timeout,
  );
});

test('stream completion, cancellation, failure and timeout release the underlying reader', async () => {
  for (const mode of ['complete', 'cancel', 'error', 'timeout']) {
    const source = new ReadableStream({
      start(controller) {
        if (mode === 'complete') {
          controller.enqueue(new TextEncoder().encode('complete'));
          controller.close();
        }
        if (mode === 'error') controller.error(new Error('Synthetic stream failure'));
      },
    });
    const response = await networkFetch(
      'https://fixture.invalid',
      {},
      {
        ...options,
        request: async () => new Response(source),
      },
    );
    if (mode === 'complete') assert.equal(await response.text(), 'complete');
    else if (mode === 'cancel') await response.body.cancel();
    else await assert.rejects(response.text(), mode === 'timeout' ? timeout : /Synthetic stream failure/);
    assert.equal(source.locked, false, mode);
  }
});

test('caller-supplied deadlines retain transport timeout classification', async t => {
  await assert.rejects(
    networkDeadline(() => new Promise(() => {}), 500, AbortSignal.timeout(10)),
    timeout,
  );
  await assert.rejects(
    networkFetch(
      'https://fixture.invalid',
      { signal: AbortSignal.timeout(10) },
      {
        ...options,
        headerTimeoutMs: 500,
        totalTimeoutMs: 500,
        request: () => new Promise(() => {}),
      },
    ),
    timeout,
  );
  const { exchangeRequest } = await import('../dist/exchange-request.js');
  const f = await fixture(t, () => {});
  await assert.rejects(
    exchangeRequest(
      'Pinned transfer',
      f.url,
      { signal: AbortSignal.timeout(10) },
      response => response.text(),
      options,
    ),
    timeout,
  );
});

test('header, body and ignored-signal transports all have caller deadlines', async t => {
  const f = await fixture(t, (_req, res, calls) => {
    if (calls.length === 2) {
      res.writeHead(200);
      res.write('partial');
    }
  });
  await assert.rejects(networkFetch(f.url, {}, options), timeout);
  const response = await networkFetch(f.url, {}, options);
  await assert.rejects(response.text(), timeout);
  await assert.rejects(
    networkFetch(f.url, {}, { ...options, request: () => new Promise(() => {}) }),
    timeout,
  );
  await assert.rejects(
    networkDeadline(() => new Promise(() => {}), 20),
    timeout,
  );
});

test('read retries are bounded; writes do not replay without an explicit receipt-safe selection', async t => {
  const f = await fixture(t, (_req, res, calls) => {
    if (calls.length < 3) return res.destroy();
    res.end('complete');
  });
  assert.equal(await (await networkFetch(f.url, {}, { ...options, retries: 2 })).text(), 'complete');
  assert.equal(f.calls.length, 3);
  const g = await fixture(t, () => {});
  await assert.rejects(
    networkFetch(g.url, { method: 'POST', body: 'same-original-payload' }, options),
    timeout,
  );
  assert.equal(g.calls.length, 1);
});

const phases = [
  ['connect', 'query', 'projectHostedAgent:capabilities', {}],
  ['select', 'query', 'projectHostedLanes:select', {}],
  ['capture', 'query', 'projectObjects:missing', {}],
  ['upload', 'mutation', 'projectObjects:prepareBatch', {}],
  [
    'saveSubmit',
    'mutation',
    'projectHostedSaves:prepare',
    { request: JSON.stringify({ operationId: 'original' }) },
  ],
  ['saveJob', 'mutation', 'projectHostedSaveJobs:submit', { operationId: 'original' }],
  ['gates', 'query', 'projectHostedOverlaps:read', {}],
  ['compose', 'mutation', 'projectHostedComposeJobs:submit', { operationId: 'original' }],
  [
    'submit',
    'mutation',
    'projectHostedLandingDesired:submit',
    { request: JSON.stringify({ operationId: 'original' }) },
  ],
  ['wait', 'query', 'projectHostedFinishObserve:page', { operationId: 'original' }],
];
for (const [phase, kind, name, args] of phases)
  test(`never-answer ${phase} returns a bounded original-operation continuation`, async t => {
    const f = await fixture(t, () => {});
    const client = deadlineConvexClient(
      f.url,
      {
        skipConvexDeploymentUrlCheck: true,
        logger: false,
        fetch: exchangeConvexFetch({ ...options, retries: 1 }),
      },
      500,
    );
    const command = {
      operationId: '11111111-1111-4111-8111-111111111111',
      message: 'preserve me',
      dependencies: [],
    };
    let failure;
    const start = performance.now();
    try {
      await client[kind](makeFunctionReference(name), args);
    } catch (error) {
      failure = error;
    }
    assert(timeout(failure));
    assert(performance.now() - start < 2000);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body, f.calls[1].body);
    const pending = networkContinuation(
      '/synthetic/lane',
      { url: f.url, projectId: 'project' },
      'finish',
      command,
      command.operationId,
      failure,
    );
    assert.equal(pending.result.inProgress, true);
    assert.equal(pending.result.next.operationId, command.operationId);
    assert.deepEqual(pending.result.replayParameters, command);
    assert.match(pending.result.command, /finish/);
    assert(!pending.result.next.retry);
  });

test('complete RPC deadline includes a stalled SDK mutation queue, not just fetch', async t => {
  const f = await fixture(t, () => {});
  const client = deadlineConvexClient(
    f.url,
    { skipConvexDeploymentUrlCheck: true, logger: false, fetch: () => new Promise(() => {}) },
    25,
  );
  const write = () => client.mutation(makeFunctionReference('test:write'), { operationId: 'same' });
  const result = await Promise.allSettled([write(), write()]);
  assert(result.every(r => r.status === 'rejected' && timeout(r.reason)));
});

test('healthy doubled dogfood-size response streams with one call and no idle requests', async t => {
  const data = Buffer.alloc(10 * 1024 * 1024, 42);
  const f = await fixture(t, (_req, res) => res.end(data));
  const response = await networkFetch(f.url, {}, { ...options, idleTimeoutMs: 2000, totalTimeoutMs: 5000 });
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.length;
  assert.equal(bytes, data.length);
  assert.equal(f.calls.length, 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.calls.length, 1);
});

test('guard rejects bare, aliased and global fetch and unwrapped Convex SDK constructors', () => {
  for (const source of [
    'fetch(url)',
    'const send = fetch; send(url)',
    'globalThis.fetch(url)',
    'globalThis["fetch"](url)',
    'const { fetch: send } = globalThis; send(url)',
    'import * as http from "node:https"; http.request(url)',
    'import http from "node:https"; http.get(url)',
    'await import("node:https")',
    'networkFetch(url, { signal: AbortSignal.timeout(600000) })',
    'new ConvexHttpClient(url)',
    "import { ConvexHttpClient as Client } from 'convex/browser'; new Client(url)",
  ])
    for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])
      assert(networkBoundaryFindings(`src/unsafe.${extension}`, source).length, source);
  assert.deepEqual(
    networkBoundaryFindings(
      'src/safe.ts',
      "import { networkFetch } from './network-fetch.js'; const request: typeof fetch = networkFetch; request(url);",
    ),
    [],
  );
});

test('pending CLI and MCP transport replies replay the actual journal after a lost committed response', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { ForgeError } = await import('../dist/errors.js');
  const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
  const s = agentFixture(t),
    transport = s.transport();
  const mutation = transport.mutation.bind(transport);
  let lose = true;
  transport.mutation = async (name, args) => {
    const result = await mutation(name, args);
    if (name === 'projectHostedLanding:enqueue' && lose) {
      lose = false;
      throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Submission response timed out.');
    }
    return result;
  };
  const command = {
    candidateId: s.candidate.id,
    composeOperationId: '22222222-2222-4222-8222-222222222222',
    message: 'same-source',
  };
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  const stderr = [];
  t.mock.method(process.stderr, 'write', value => {
    stderr.push(value);
    return true;
  });
  const pending = await hostedAgentCli(s.root, 'finish', command, s.address, transport);
  assert.equal(pending.result.status, 'in-progress');
  assert.equal(process.exitCode, 3);
  assert(stderr.join('').includes('IN PROGRESS'));
  assert.equal(pending.result.next.operationId, pending.operationId);
  const first = s.calls.find(call => call.name === 'projectHostedLanding:enqueue');
  const { action, url, projectId, ...next } = pending.result.next;
  assert.equal(action, 'finish');
  assert.equal(url, s.address.url);
  assert.equal(projectId, s.address.projectId);
  const resumed = await transport.dispatch(action, next);
  assert.equal(resumed.operationId, pending.operationId);
  const calls = s.calls.filter(call => call.name === 'projectHostedLanding:enqueue');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.request, first.args.request);
  assert.equal(s.operations.size, 1, 'one original durable submission, not a replacement');
});

test('discovery exhaustion retains shorthand without inventing an operation before a journal exists', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { ForgeError } = await import('../dist/errors.js');
  const s = agentFixture(t),
    transport = s.transport();
  transport.query = async () => {
    throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Discovery deadline.');
  };
  const original = { message: 'original', dependencies: [] };
  const pending = await transport.dispatch('finish', original);
  assert.equal(pending.operationId, null);
  assert.deepEqual(pending.result.replayParameters, original);
  assert(!('operationId' in pending.result.next));
  assert.equal(s.calls.length, 0);
});

test('R2 PUT body/header stalls abort once and preserve the pinned upload body', async t => {
  const f = await fixture(t, () => {});
  const body = Buffer.from('pinned source bytes');
  await assert.rejects(networkFetch(f.url, { method: 'PUT', body }, options), timeout);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body, body.toString());
});

test('portable transport timeouts stay distinct from deterministic Forge source errors', async () => {
  const { ForgeError } = await import('../dist/errors.js');
  await assert.rejects(
    networkDeadline(() => new Promise(() => {}), 10),
    error => {
      assert.equal(error.code, 'EXCHANGE_REQUEST_TIMEOUT');
      assert(!(error instanceof ForgeError));
      return true;
    },
  );
});

test('subscription cleanup still runs after its observation has been cancelled', async () => {
  const { deadlineConvexSubscription } = await import('../dist/network-convex-client.js');
  const { withExchangeProgress } = await import('../dist/exchange-progress.js');
  const client = deadlineConvexSubscription('https://fixture.convex.cloud', { disabled: true });
  let closed = false;
  client.close = async () => {
    closed = true;
  };
  const controller = new AbortController();
  controller.abort();
  await withExchangeProgress({ signal: controller.signal }, () => client.close());
  assert.equal(closed, true);
});

test('healthy 575 and doubled operation counts make exactly one RPC per operation', async t => {
  const { getFunctionName } = await import('convex/server');
  let calls = 0;
  const client = deadlineConvexClient('https://fixture.convex.cloud', {
    logger: false,
    fetch: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).path, getFunctionName(reference));
      return new Response(JSON.stringify({ status: 'success', value: null }));
    },
  });
  const reference = makeFunctionReference('projectHostedLanes:head');
  const start = performance.now(),
    rss = process.memoryUsage().rss;
  for (const size of [575, 1150]) {
    calls = 0;
    for (let i = 0; i < size; i++) await client.query(reference, { laneId: `lane-${i}` });
    assert.equal(calls, size);
  }
  const rssDelta = Math.max(0, process.memoryUsage().rss - rss);
  assert(
    rssDelta < 64 * 1024 * 1024,
    'sequential metadata RPCs retain less than 64 MiB above the loaded client',
  );
  t.diagnostic(
    `575/1150 operations: 1 RPC each, 0 added metadata reads/writes, 0 idle calls; ${Math.round(performance.now() - start)} ms; RSS delta ${Math.max(0, process.memoryUsage().rss - rss)} bytes`,
  );
});

test('registered MCP task exposes the same pending envelope and exact original operation', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { registerAgentWorkflow } = await import('../dist/mcp-agent-workflow.js');
  const { ForgeError } = await import('../dist/errors.js');
  const s = agentFixture(t),
    transport = s.transport(),
    tools = new Map();
  const close = registerAgentWorkflow(
    {
      registerTool(name, _config, call) {
        tools.set(name, call);
      },
    },
    s.root,
    transport,
  );
  t.after(close);
  transport.query = async () => {
    throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Discovery deadline.');
  };
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  t.mock.method(process.stderr, 'write', () => true);
  const operationId = '44444444-4444-4444-8444-444444444444';
  const reply = await tools.get('forge_task')({
    command: { action: 'finish', operationId, message: 'same MCP input' },
  });
  assert(!reply.isError);
  const pending = JSON.parse(reply.content[0].text);
  assert.equal(pending.result.inProgress, true);
  assert.equal(pending.result.next.operationId, operationId);
  assert.equal(pending.result.next.message, 'same MCP input');
});

test('record actions preserve the operation chosen before an unknown mutation response', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { ForgeError } = await import('../dist/errors.js');
  const s = agentFixture(t),
    transport = s.transport(),
    requests = [];
  let lose = true;
  s.exchange.client.mutation = async (_reference, args) => {
    requests.push(args.request);
    if (lose) throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Record response timed out.');
    return {};
  };
  const command = {
    laneId: s.lane.laneId,
    title: 'Synthetic friction',
    detail: 'Same original evidence',
    area: 'cli',
  };
  const pending = await transport.dispatch('friction', command);
  assert.equal(pending.result.inProgress, true);
  assert.equal(JSON.parse(requests[0]).operationId, pending.operationId);
  assert.equal(pending.result.next.operationId, pending.operationId);
  lose = false;
  const { action, url: _url, projectId: _projectId, ...next } = pending.result.next;
  const resumed = await transport.dispatch(action, next);
  assert.equal(resumed.operationId, pending.operationId);
  assert.equal(requests[0], requests[1]);
});

test('an active body read keeps its deadline alive without a socket or other timer', async () => {
  const response = await networkFetch(
    'https://fixture.invalid',
    {},
    {
      ...options,
      request: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
    },
  );
  await assert.rejects(response.text(), timeout);
});

test('caller cancellation reaches streaming HTTP alongside its own per-call signal', async () => {
  const { withExchangeProgress } = await import('../dist/exchange-progress.js');
  const controller = new AbortController(),
    local = new AbortController();
  const pending = withExchangeProgress({ signal: controller.signal }, async () => {
    const response = await networkFetch(
      'https://fixture.invalid',
      { signal: local.signal },
      {
        ...options,
        request: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
      },
    );
    const read = response.text();
    controller.abort(new Error('Synthetic cancellation'));
    return read;
  });
  await assert.rejects(pending, /Synthetic cancellation/);
  assert.equal(local.signal.aborted, false);
});

test('queued HTTP mutations retain serial order and never send expired callers later', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let calls = 0;
  const client = deadlineConvexClient(
    'https://fixture.convex.cloud',
    {
      logger: false,
      fetch: async () => {
        calls++;
        await gate;
        return new Response(JSON.stringify({ status: 'success', value: null }));
      },
    },
    25,
  );
  const mutate = () => client.mutation(makeFunctionReference('test:write'), { operationId: 'same' });
  const results = await Promise.allSettled([mutate(), mutate()]);
  assert(results.every(result => result.status === 'rejected' && timeout(result.reason)));
  assert.equal(calls, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'expired queued request must not begin after its caller returned pending');
});

test('healthy HTTP mutations keep the SDK serial order and the explicit skipQueue option', async () => {
  const ids = [];
  let active = 0,
    peak = 0;
  const client = deadlineConvexClient('https://fixture.convex.cloud', {
    logger: false,
    fetch: async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      ids.push(JSON.parse(init.body).args[0].operationId);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return new Response(JSON.stringify({ status: 'success', value: null }));
    },
  });
  const mutate = (id, options) =>
    client.mutation(makeFunctionReference('test:write'), { operationId: id }, options);
  await Promise.all(Array.from({ length: 20 }, (_, i) => mutate(`op-${i}`)));
  assert.deepEqual(
    ids,
    Array.from({ length: 20 }, (_, i) => `op-${i}`),
  );
  assert.equal(peak, 1);
  await Promise.all([mutate('parallel-1', { skipQueue: true }), mutate('parallel-2', { skipQueue: true })]);
  assert.equal(peak, 2);
});

test('source-pack recovery pins its original main while fresh commands still select current main', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { HostedCheckoutCache } = await import('../dist/hosted-checkout-cache.js');
  const { getFunctionName } = await import('convex/server');
  const { ForgeError } = await import('../dist/errors.js');
  const s = agentFixture(t),
    transport = s.transport(),
    original = s.main.head;
  // This fixture supplies object bytes through its download seam rather than
  // signed HTTP locations; preload that state before exercising publication.
  await new HostedCheckoutCache(`${s.root}.forge-client`, s.exchange, undefined, null).ensure([original]);
  const query = s.exchange.client.query,
    mutation = s.exchange.client.mutation;
  let mainReads = 0,
    lose = true;
  s.exchange.client.query = (reference, args) => {
    if (getFunctionName(reference) === 'projectHostedChannels:current') mainReads++;
    return query(reference, args);
  };
  s.exchange.client.mutation = (reference, args) =>
    getFunctionName(reference) === 'projectSourcePackClient:latest'
      ? Promise.resolve(null)
      : mutation(reference, args);
  s.exchange.client.action = async reference => {
    assert.equal(getFunctionName(reference), 'projectSourcePackClient:publish');
    if (lose) throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Pack publication response unknown.');
    return null;
  };
  const pending = await transport.dispatch('source-pack', {});
  assert.equal(pending.result.inProgress, true);
  assert(pending.operationId);
  s.main.head = 'b'.repeat(64);
  lose = false;
  const { action, url: _url, projectId: _projectId, ...next } = pending.result.next;
  const resumed = await transport.dispatch(action, next);
  assert.equal(resumed.operationId, pending.operationId);
  assert.equal(resumed.result.stateRef, original);
  assert.equal(mainReads, 1, 'replay uses the retained main selection');
  s.main.head = original;
  const fresh = await transport.dispatch('source-pack', {});
  assert.notEqual(fresh.operationId, pending.operationId);
  assert.equal(mainReads, 2, 'a fresh command still selects current main');
});

test('concurrent calls on one MCP transport never exchange original operation identities', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { ForgeError } = await import('../dist/errors.js');
  const s = agentFixture(t),
    transport = s.transport(),
    releases = [];
  transport.query = async () => {
    await new Promise(resolve => {
      releases.push(resolve);
    });
    throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'Synthetic discovery timeout.');
  };
  const ids = ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
  const pending = ids.map(operationId =>
    transport.dispatch('finish', {
      operationId,
      candidateId: s.candidate.id,
      composeOperationId: '77777777-7777-4777-8777-777777777777',
    }),
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases.forEach(release => release());
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map(result => result.operationId),
    ids,
  );
  assert.deepEqual(
    results.map(result => result.result.next.operationId),
    ids,
  );
});
