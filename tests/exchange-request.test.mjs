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

// Short deadlines are only used by tests that make them fire, and those tests run on fakeClock.
// Tests that need an answer keep the production deadlines, so a loaded runner cannot fire a
// deadline the test does not exercise (a0fd0893: 150 ms header/idle timers raced the fixture).
const deadlines = { headerTimeoutMs: 150, idleTimeoutMs: 150, totalTimeoutMs: 2000, retries: 1, delayMs: 5 };
const answered = { retries: 1, delayMs: 5 };

/** Resolves waiters each time a test-visible event happens; waits are events, never sleeps. */
function events() {
  let waiters = [];
  return {
    notify: () => waiters.splice(0).forEach(wake => wake()),
    async until(ready) {
      while (!ready()) await new Promise(wake => waiters.push(wake));
    },
  };
}

// Node's fetch (undici) creates one module-level tick timer for its own socket timeouts and only
// refreshes it afterwards. Create it on the real clock before any fakeClock test: a tick timer
// created on mocked timers dies with that test and stops undici's own timers for later tests.
{
  const server = createServer((_req, res) => res.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await (await fetch(`http://127.0.0.1:${server.address().port}`)).text();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

/** Deadlines under test fire only when the test advances virtual time, after waiting for the
 * fixture event that must precede them. The fixture server shares this event loop, so with the
 * real clock any stall longer than a deadline reordered "server answered" and "deadline fired".
 * Load can still delay events here, but can no longer reorder them. */
function fakeClock(t) {
  const real = { clearTimeout, clearInterval };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  // Timeout classification (total vs idle vs headers) reads performance.now().
  t.mock.method(performance, 'now', () => Date.now());
  const mocked = { setTimeout, setInterval, clearTimeout, clearInterval },
    own = new WeakSet(),
    armed = new Map(),
    changes = events();
  // Count armed delays so a back-off is advanced only once the code under test has armed it.
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = mocked.setTimeout(fn, ms, ...args);
    own.add(handle);
    armed.set(ms, (armed.get(ms) ?? 0) + 1);
    changes.notify();
    return handle;
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    const handle = mocked.setInterval(fn, ms, ...args);
    own.add(handle);
    return handle;
  };
  // Mocked timers clear by queue position, so a handle from a real timer or an earlier test's clock
  // (a late socket 'close' handler) would remove an unrelated pending timer here.
  globalThis.clearTimeout = handle => (own.has(handle) ? mocked.clearTimeout : real.clearTimeout)(handle);
  globalThis.clearInterval = handle => (own.has(handle) ? mocked.clearInterval : real.clearInterval)(handle);
  // Resetting the mock timers after the test restores all four real functions over these wrappers.
  return {
    tick: ms => t.mock.timers.tick(ms),
    async backoff(ms) {
      await changes.until(() => armed.get(ms) > 0);
      armed.set(ms, armed.get(ms) - 1);
      t.mock.timers.tick(ms);
    },
  };
}

async function fixture(t, handler) {
  const requests = [],
    sockets = new Set(),
    received = events();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    handler(req, res, requests.length);
    received.notify();
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
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    seen: n => received.until(() => requests.length >= n),
  };
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
  const clock = fakeClock(t);
  const pending = exchangeFetch('manifest', `${f.url}/?token=secret`, {}, deadlines);
  await f.seen(1);
  clock.tick(150);
  await clock.backoff(5);
  await f.seen(2);
  clock.tick(150);
  await assert.rejects(pending, timedOut('manifest', 'response headers'));
  assert.equal(f.requests.length, 2);
});

test('half a body then no progress times out and retries the complete read', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': 8 });
    res.write('half');
  });
  const clock = fakeClock(t),
    progress = [],
    bytes = events();
  const pending = exchangeFetch(
    'work.json download',
    f.url,
    {},
    {
      ...deadlines,
      onBytes: (done, total) => {
        progress.push([done, total]);
        bytes.notify();
      },
    },
  );
  for (const attempt of [1, 2]) {
    await bytes.until(() => progress.length === 2 * attempt);
    clock.tick(150);
    if (attempt === 1) await clock.backoff(5);
  }
  await assert.rejects(pending, timedOut('work.json', 'body idle'));
  assert.equal(f.requests.length, 2);
  assert.deepEqual(progress, [
    [0, 8],
    [4, 8],
    [0, 8],
    [4, 8],
  ]);
});

test('continuous body progress resets idle time but cannot evade the total cap', async t => {
  const written = [];
  const f = await fixture(t, (_req, res, n) => {
    written[n] = 1;
    res.writeHead(200);
    res.write('x');
    const timer = setInterval(() => {
      written[n]++;
      res.write('x');
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  // A byte every 100 ms against a 150 ms idle deadline and a 900 ms total cap. Virtual time moves
  // 100 ms only after every written byte reached the client, so idle never expires and the
  // total cap is the deadline that ends each attempt, however long the runner stalls.
  const clock = fakeClock(t),
    bytes = events();
  let received = 0;
  const pending = exchangeFetch(
    'stream',
    f.url,
    {},
    {
      ...deadlines,
      totalTimeoutMs: 900,
      onBytes: done => {
        received = done;
        bytes.notify();
      },
    },
  );
  for (const attempt of [1, 2]) {
    await f.seen(attempt);
    received = 0;
    for (let elapsed = 0; elapsed < 900; elapsed += 100) {
      await bytes.until(() => received === written[attempt]);
      clock.tick(100);
    }
    if (attempt === 1) await clock.backoff(5);
  }
  await assert.rejects(pending, timedOut('stream', 'total request'));
  assert.equal(f.requests.length, 2);
  assert(written[2] > 900 / 150, 'body progress outlived the idle deadline several times');
});

test('stalled response retry discards partial bytes and returns only a complete successful body', async t => {
  const f = await fixture(t, (_req, res, n) => {
    res.writeHead(200, { 'Content-Length': 8 });
    if (n === 1) res.write('bad!');
    else res.end('complete');
  });
  const clock = fakeClock(t),
    bytes = events();
  let received = 0;
  const pending = exchangeFetch(
    'download',
    f.url,
    {},
    {
      ...deadlines,
      onBytes: done => {
        received = done;
        bytes.notify();
      },
    },
  );
  await bytes.until(() => received === 4);
  clock.tick(150);
  await clock.backoff(5);
  const response = await pending;
  assert.equal(await response.text(), 'complete');
  assert.equal(f.requests.length, 2);
});

test('HTTP retries back off; permission failures and Convex structured errors remain final', async t => {
  for (const status of [403, 429, 503, 560]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status);
      res.end('failure');
    });
    assert.equal((await exchangeFetch('read', f.url, {}, answered)).status, status);
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
  const clock = fakeClock(t);
  const pending = client.action(makeFunctionReference('projectWorkActions:exportJournal'), {
    projectId: 'synthetic',
  });
  await f.seen(1);
  clock.tick(150);
  await clock.backoff(5);
  await f.seen(2);
  clock.tick(150);
  await assert.rejects(pending, timedOut('projectWorkActions:exportJournal', 'response headers'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body, f.requests[1].body);
});

test('hosted overlap reads retry a lost connection but current authority errors remain final', async t => {
  for (const denied of [false, true]) {
    const f = await fixture(t, (_req, res, n) => {
      if (n === 1 && !denied) return res.destroy();
      res.writeHead(denied ? 560 : 200);
      res.end(
        JSON.stringify(
          denied
            ? {
                status: 'error',
                errorData: { code: 'PROJECT_UNAVAILABLE', message: 'Current access revoked' },
                errorMessage: 'Current access revoked',
              }
            : { status: 'success', value: 'overlap advice' },
        ),
      );
    });
    const client = new ConvexHttpClient(f.url, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: exchangeConvexFetch(answered),
    });
    const read = () =>
      client.query(makeFunctionReference('projectHostedOverlaps:read'), {
        projectId: 'synthetic',
        laneId: 'same-lane',
      });
    if (denied) await assert.rejects(read, error => error.data?.code === 'PROJECT_UNAVAILABLE');
    else assert.equal(await read(), 'overlap advice');
    assert.equal(f.requests.length, denied ? 1 : 2);
    if (!denied) assert.equal(f.requests[0].body, f.requests[1].body);
  }
});

test('receipt-reconciled Convex actions retry identical operation IDs; unknown actions do not replay', async t => {
  const f = await fixture(t, (_req, res, n) => {
    if (n === 1) return res.destroy();
    res.end(JSON.stringify({ status: 'success', value: 'receipt' }));
  });
  const client = new ConvexHttpClient(f.url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: exchangeConvexFetch(answered),
  });
  assert.equal(
    await client.action(makeFunctionReference('projectExchangeMigration:migrate'), {
      projectId: 'synthetic',
      operationId: 'same-original-id',
    }),
    'receipt',
  );
  assert.equal(f.requests[0].body, f.requests[1].body);
  const g = await fixture(t, () => {});
  const clock = fakeClock(t);
  const unknown = exchangeConvexFetch(deadlines)(`${g.url}/api/action`, {
    method: 'POST',
    body: JSON.stringify({ path: 'unknown:write', args: [{}] }),
  });
  await g.seen(1);
  clock.tick(150);
  await assert.rejects(
    unknown,
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
    fetch: exchangeConvexFetch(answered),
  });
  await assert.rejects(
    client.action(makeFunctionReference('projectExchangeMigration:migrate'), { operationId: 'original' }),
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
    answered,
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

test('active call tracking clears completed and timed-out Convex calls', async t => {
  for (const stall of [false, true]) {
    const f = await fixture(t, (_req, res) => {
      if (!stall) res.end('{}');
    });
    const progress = [],
      clock = stall ? fakeClock(t) : undefined;
    const response = exchangeConvexFetch(stall ? deadlines : answered, (name, pending) =>
      progress.push([name, pending]),
    )(`${f.url}/api/action`, {
      method: 'POST',
      body: JSON.stringify({ path: 'projectWorkActions:exportJournal', args: [{}] }),
    });
    if (clock) {
      await f.seen(1);
      clock.tick(150);
      await clock.backoff(5);
      await f.seen(2);
      clock.tick(150);
      await assert.rejects(response, error => error.code === 'EXCHANGE_REQUEST_TIMEOUT');
    } else await response;
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

test('long actions keep the seven-minute header and total deadline; quick calls keep short deadlines', async t => {
  const realTimeout = globalThis.setTimeout,
    timers = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    timers.push(ms);
    return realTimeout(fn, ms, ...args);
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const fetch = exchangeConvexFetch();
  for (const path of [
    'projectWorkActions:exportJournal',
    'projectWorkIndexActions:ensure',
    'projectExchangeActions:manifest',
    'projectObjectRecipes:complete',
    'projectWorkActions:initialize',
    'projectExchangeMigration:migrate',
  ]) {
    timers.length = 0;
    await fetch('https://fixture.invalid/api/action', { body: JSON.stringify({ path, args: [{}] }) });
    assert.deepEqual(timers.slice(0, 2), [420000, 420000], path);
  }
  for (const [api, path] of [
    ['query', 'projectHostedChannels:current'],
    ['mutation', 'projectObjects:prepareBatch'],
    ['action', 'projectExchangeActions:checkpoint'],
    ['action', 'projectExchangeActions:downloadPart'],
  ]) {
    timers.length = 0;
    await fetch(`https://fixture.invalid/api/${api}`, { body: JSON.stringify({ path, args: [{}] }) });
    // The total deadline may be armed before the header deadline; both budgets remain exact.
    assert.deepEqual(
      timers.slice(0, 2).sort((a, b) => a - b),
      [30000, 120000],
      path,
    );
  }
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
    body: JSON.stringify({ path: 'projectExchangeActions:manifest', args: [{}] }),
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].headersTimeout, 420000);
  await fetch('https://fixture.invalid/api/query', {
    body: JSON.stringify({ path: 'projectHostedChannels:current', args: [{}] }),
  });
  assert.equal(dispatched.length, 1);
});

test('a completed request never aborts its closed response stream', async t => {
  const { url } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-length': '5' });
    res.end();
  });
  // The Convex runtime fails the action asynchronously when a completed stream is aborted.
  const abort = AbortController.prototype.abort;
  let aborts = 0;
  AbortController.prototype.abort = function (...args) {
    aborts++;
    return abort.apply(this, args);
  };
  t.after(() => {
    AbortController.prototype.abort = abort;
  });
  const response = await exchangeFetch('R2 object HEAD verification', url, { method: 'HEAD' }, answered);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '5');
  assert.equal(aborts, 0);
  // A reader that throws after the response arrived, and its retry, also never abort.
  let reads = 0;
  await assert.rejects(
    exchangeRequest(
      'R2 object HEAD verification',
      url,
      { method: 'HEAD' },
      async () => {
        reads++;
        throw new Error('synthetic reader failure');
      },
      { ...answered, delayMs: 1 },
    ),
    error => error.code === 'EXCHANGE_REQUEST_FAILED',
  );
  assert.equal(reads, 2);
  assert.equal(aborts, 0);
});

test('pending long actions continue the exact payload immediately and expose saved progress', async t => {
  const events = [];
  const f = await fixture(t, (_req, res, n) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'success',
        value:
          n < 10
            ? { pending: true, progress: JSON.stringify({ phase: 'index', step: n, done: n, total: 10 }) }
            : 'receipt',
      }),
    );
  });
  const client = new ConvexHttpClient(f.url, {
    skipConvexDeploymentUrlCheck: true,
    fetch: exchangeConvexFetch(answered, (name, pending) => events.push({ name, pending })),
  });
  assert.equal(
    await client.action(makeFunctionReference('projectWorkIndexActions:ensure'), {
      operationId: 'original',
      digest: 'pinned',
      size: 1,
    }),
    'receipt',
  );
  assert.equal(f.requests.length, 10);
  const args = f.requests.map(r => JSON.parse(r.body).args[0]);
  assert.equal(args[0].continuation, undefined);
  assert(args.slice(1).every(a => a.continuation === true));
  assert(args.every(a => a.operationId === 'original' && a.digest === 'pinned' && a.size === 1));
  assert(events.some(e => e.pending && e.name.includes('"done":9')));
});

test('HTTP pending with changing elapsed time but no saved position stops finitely', async t => {
  const f = await fixture(t, (_req, res, n) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'success',
        value: { pending: true, progress: JSON.stringify({ phase: 'index', step: 1, elapsedMs: n * 1000 }) },
      }),
    );
  });
  const client = new ConvexHttpClient(f.url, {
    skipConvexDeploymentUrlCheck: true,
    fetch: exchangeConvexFetch(answered),
  });
  await assert.rejects(
    client.action(makeFunctionReference('projectWorkIndexActions:ensure'), { projectId: 'project' }),
    /no committed progress.*Retry the original operation/,
  );
  assert.equal(f.requests.length, 6);
});

test('redirected Convex storage/recipe reads bound headers and the complete body', async t => {
  const { ConvexExchangeBlobs } = await import('../dist/exchange-blobs.js');
  // The production 30 s header/idle deadlines and 100 ms doubling back-off, in virtual time.
  const clock = fakeClock(t);
  const bytes = Buffer.from('complete'),
    pin = { sha256: digest(bytes), size: bytes.length };
  for (const halfBody of [false, true]) {
    const f = await fixture(t, (_req, res, n) => {
      if (n <= 4) {
        if (halfBody) {
          res.writeHead(200, { 'Content-Length': bytes.length });
          res.write('half');
        }
        return;
      }
      res.end(bytes);
    });
    const blobs = new ConvexExchangeBlobs({
      action: async () => ({ direct: true, digest: pin.sha256, size: pin.size }),
      mutation: async () => [{ digest: pin.sha256, size: pin.size, location: 'convex', url: f.url }],
    });
    const pending = blobs.getPart('synthetic', pin, 0);
    for (const attempt of [1, 2, 3, 4]) {
      await f.seen(attempt);
      clock.tick(30_000);
      if (attempt < 4) await clock.backoff(100 * 2 ** (attempt - 1));
    }
    await assert.rejects(pending, error => error.code === 'EXCHANGE_REQUEST_TIMEOUT');
    assert.equal(f.requests.length, 4);
    assert.deepEqual(Buffer.from((await blobs.getPart('synthetic', pin, 0)).data), bytes);
  }
});

test('cooperative cancellation stops retries and aborts a header/body stall before queue release', async t => {
  const { withExchangeProgress } = await import('../dist/exchange-progress.js');
  for (const halfBody of [false, true]) {
    let accepted;
    const entered = new Promise(resolve => {
      accepted = resolve;
    });
    const f = await fixture(t, (_req, res) => {
      if (halfBody) {
        res.writeHead(200);
        res.write('half');
      }
      accepted();
    });
    // Virtual time never advances here: only the cancellation can end the stalled read.
    if (!halfBody) fakeClock(t);
    const controller = new AbortController();
    const pending = withExchangeProgress({ signal: controller.signal }, () =>
      exchangeFetch('synthetic read', f.url, {}, deadlines),
    );
    await entered;
    controller.abort(new ForgeError('AUTO_EXCHANGE_STALLED', 'Yield to retained-operation recovery.'));
    await assert.rejects(pending, error => error.code === 'AUTO_EXCHANGE_STALLED');
    assert.equal(f.requests.length, 1);
  }
});
