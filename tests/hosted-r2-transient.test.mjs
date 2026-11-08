// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureFixture } from './convex-source-failure-fixture.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { loadTaskData } from '../dist/hosted-source-task-data.js';
import { r2LagDelays, retryR2Lag } from '../dist/hosted-r2-retry.js';

const fakeGet =
  f =>
  (url, init = {}) => {
    const bytes = f.r2.objects.get(new URL(url).pathname);
    return Promise.resolve(
      bytes && (!init.method || init.method === 'GET')
        ? new Response(bytes)
        : new Response(null, { status: 404 }),
    );
  };
const { storeSourceBytes } = await import(moduleUrl('../convex/projectSourceBytes.ts'));

/** Wrap the current fetch so the first `lag` GETs of the pinned object answer 404. */
function lagGets(t, sha256, lag) {
  const next = globalThis.fetch;
  const seen = { gets: 0 };
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    if ((!init.method || init.method === 'GET') && String(url).includes(sha256) && ++seen.gets <= lag)
      return Promise.resolve(new Response(null, { status: 404 }));
    return next(url, init);
  });
  return seen;
}

test('policy: bounded to two extra tries, none on the healthy path', async () => {
  assert.deepEqual([...r2LagDelays], [400, 1600]);
  const waits = [];
  const sleep = async ms => void waits.push(ms);
  let n = 0;
  assert.equal(
    await retryR2Lag(
      async () => ++n,
      () => false,
      undefined,
      sleep,
    ),
    1,
  );
  assert.deepEqual(waits, [], 'healthy path never waits or retries');
  n = 0;
  const discarded = [];
  assert.equal(
    await retryR2Lag(
      async () => ++n,
      () => true,
      v => discarded.push(v),
      sleep,
    ),
    3,
    'two extra tries then the last answer is returned',
  );
  assert.deepEqual(waits, [400, 1600]);
  assert.deepEqual(discarded, [1, 2]);
});

for (const fault of [503, 429, 'headers', 'body']) {
  test(`verify: ${fault} then success replays the same quantum, no terminal failure`, async t => {
    const f = await failureFixture(t, 'verify');
    f.fault(fault);
    await assert.rejects(f.run());
    assert.deepEqual(f.completions(), [], 'nothing terminal is committed');
    assert.equal(f.hits(), 1, 'transient statuses are not retried in-action');
    f.fault(null);
    await f.run();
    assert.equal(f.completions().length, 1);
    assert.equal(f.completions()[0].args.failure, null);
  });
}

test('verify: a persistent 503 keeps its exact cause on every attempt and never settles the job', async t => {
  const f = await failureFixture(t, 'verify');
  f.fault(503);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(f.run());
    assert.equal(f.hits(), attempt);
  }
  assert.deepEqual(f.completions(), []);
  const failed = f.calls.filter(c => c.name.endsWith(':failed'));
  assert.equal(failed.length, 3, 'each attempt records its bounded cause for the scheduled repair');
  for (const { args } of failed) {
    assert.equal(args.cause.httpStatus, 503);
    assert.equal(args.cause.stage, 'source-headers');
    assert.equal(args.cause.object, f.object.sha256);
  }
  assert(!JSON.stringify(f.logs).includes('private'));
});

for (const mismatch of ['size', 'digest']) {
  test(`verify: a ${mismatch} mismatch fails immediately with its exact code (one GET)`, async t => {
    const f = await failureFixture(t, 'verify');
    const serve = globalThis.fetch;
    let gets = 0;
    t.mock.method(globalThis, 'fetch', (url, init = {}) => {
      if (init.method && init.method !== 'GET') return serve(url, init);
      gets++;
      return Promise.resolve(new Response(mismatch === 'size' ? 'x' : Buffer.alloc(f.object.size, 122)));
    });
    await f.run();
    assert.equal(f.completions()[0].args.failure, 'SOURCE_HASH_MISMATCH');
    assert.equal(gets, 1);
  });
}

for (const wrapper of ['task', 'node', 'small']) {
  test(`${wrapper}: a just-written object missing once then visible is read with one extra GET`, async t => {
    const f = await failureFixture(t, 'verify', wrapper);
    const seen = lagGets(t, f.object.sha256, 1);
    await f.run();
    assert.equal(f.completions()[0].args.failure, null);
    assert.equal(seen.gets, 2);
  });
}

test('verify: an object that stays 404 fails with SOURCE_UNAVAILABLE after exactly two extra GETs', async t => {
  const f = await failureFixture(t, 'verify');
  const seen = lagGets(t, f.object.sha256, Infinity);
  await f.run();
  assert.equal(f.completions()[0].args.failure, 'SOURCE_UNAVAILABLE');
  assert.equal(seen.gets, 1 + r2LagDelays.length);
});

test('states: a 404 that clears is not recorded as an invalid State; a persistent one keeps its code', async t => {
  const lagged = await failureFixture(t, 'states');
  lagGets(t, lagged.object.sha256, 2);
  await lagged.run();
  const ok = lagged.completions()[0].args;
  assert.equal(ok.failure, null);
  assert.equal((await loadTaskData(ok.output, lagged.durable.read)).states[0].error, null);
});

test('states: a persistent 404 settles the exact SOURCE_UNAVAILABLE after the bound', async t => {
  const f = await failureFixture(t, 'states');
  const seen = lagGets(t, f.object.sha256, Infinity);
  await f.run();
  const complete = f.completions()[0].args;
  assert.equal(seen.gets, 1 + r2LagDelays.length);
  assert.equal(complete.failure, null);
  // stateSummary records the proven absence; loading the summary needs a working GET.
  t.mock.method(globalThis, 'fetch', fakeGet(f));
  assert.equal((await loadTaskData(complete.output, f.durable.read)).states[0].error, 'SOURCE_UNAVAILABLE');
});

function lagHeads(t, lag) {
  const r2 = fakeSourceR2(t);
  const next = globalThis.fetch;
  const seen = { heads: 0 };
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    if (init.method === 'HEAD' && ++seen.heads <= lag)
      return Promise.resolve(new Response(null, { status: 404 }));
    return next(url, init);
  });
  return { r2, seen };
}
const bytes = Buffer.from('r2 read-after-write\n');
const pin = { sha256: digest(bytes), size: bytes.length };
const project = 'project';

test('store: healthy PUT+HEAD makes exactly two requests', async t => {
  const { r2 } = lagHeads(t, 0);
  const stored = await storeSourceBytes({ storage: {} }, project, bytes, pin);
  assert('r2Key' in stored);
  assert.deepEqual(r2.requests, ['PUT', 'HEAD']);
});

test('store: a 200 PUT that echoes the exact signed checksum needs no HEAD (one request)', async t => {
  const { r2 } = lagHeads(t, 0);
  r2.hooks.echo = true;
  assert('r2Key' in (await storeSourceBytes({ storage: {} }, project, bytes, pin)));
  assert.deepEqual(r2.requests, ['PUT']);
  // The object already exists (412): the existing binding is still confirmed by HEAD.
  assert('r2Key' in (await storeSourceBytes({ storage: {} }, project, bytes, pin)));
  assert.deepEqual(r2.requests, ['PUT', 'PUT', 'HEAD']);
});

test('store: an echo that differs from the signed checksum falls back to the HEAD check', async t => {
  const r2 = fakeSourceR2(t);
  const next = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const response = await next(url, init);
    return init.method === 'PUT'
      ? new Response(null, { status: response.status, headers: { 'x-amz-checksum-sha256': 'other' } })
      : response;
  });
  r2.hooks.mismatch = true;
  await assert.rejects(storeSourceBytes({ storage: {} }, project, bytes, pin), { code: 'R2_VERIFY_FAILED' });
  assert.deepEqual(r2.requests, ['PUT', 'HEAD']);
});

test('store: HEAD 404 right after our PUT is retried and then verifies', async t => {
  const { r2, seen } = lagHeads(t, 2);
  assert('r2Key' in (await storeSourceBytes({ storage: {} }, project, bytes, pin)));
  assert.equal(seen.heads, 3);
  assert.deepEqual(r2.requests, ['PUT', 'HEAD']);
});

test('store: HEAD that stays 404 fails with R2_VERIFY_FAILED after exactly two extra HEADs', async t => {
  const { seen } = lagHeads(t, Infinity);
  await assert.rejects(storeSourceBytes({ storage: {} }, project, bytes, pin), {
    code: 'R2_VERIFY_FAILED',
  });
  assert.equal(seen.heads, 1 + r2LagDelays.length);
});

test('store: a checksum mismatch is permanent at once (one HEAD, no retry)', async t => {
  const { r2, seen } = lagHeads(t, 0);
  r2.hooks.mismatch = true;
  await assert.rejects(storeSourceBytes({ storage: {} }, project, bytes, pin), {
    code: 'R2_VERIFY_FAILED',
  });
  assert.equal(seen.heads, 1);
});

test('store: a transient 503 on the verifying HEAD stays a retryable SourceIoError', async t => {
  fakeSourceR2(t);
  const next = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init = {}) =>
    init.method === 'HEAD' ? Promise.resolve(new Response('private', { status: 503 })) : next(url, init),
  );
  await assert.rejects(storeSourceBytes({ storage: {} }, project, bytes, pin), error => {
    assert.equal(error.name, 'SourceIoError');
    assert.equal(error.httpStatus, 503);
    return true;
  });
});
