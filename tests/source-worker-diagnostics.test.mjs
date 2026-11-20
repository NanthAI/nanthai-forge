// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { failureFixture, identity } from './convex-source-failure-fixture.mjs';
import { sourceFailureSchema } from '../dist/hosted-source-retry.js';

for (const code of [
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
])
  test('worker receipt retains a safe typed dependency failure: ' + code, async t => {
    const f = await failureFixture(t, 'verify');
    const original = f.ctx.runMutation;
    f.ctx.runMutation = (ref, args) => {
      if (getFunctionName(ref).endsWith(':begin'))
        throw Object.assign(new Error('https://private.invalid/?secret=sentinel'), { code });
      return original(ref, args);
    };
    await assert.rejects(
      f.run(),
      e => e.name === 'SourceIoError' && e.code === code && !e.message.includes('sentinel'),
    );
    const failure = f.calls.find(c => c.name.endsWith(':failed')).args.cause;
    assert.equal(failure.code, code);
    assert.equal(failure.step, identity.step);
    assert.equal(failure.call, 'task-begin');
    assert(!JSON.stringify({ failure, logs: f.logs }).includes('sentinel'));
    assert.deepEqual(sourceFailureSchema.parse(failure), failure);
  });

test('worker canonical diagnostics retain the object and size across nested wrappers', async t => {
  const f = await failureFixture(t, 'calculate');
  f.fault('headers');
  await assert.rejects(f.run(), { name: 'SourceIoError' });
  const failure = f.calls.find(c => c.name.endsWith(':failed')).args.cause;
  assert.equal(failure.step, identity.step);
  assert.equal(failure.call, 'merge-read');
  assert.equal(failure.object, f.object.sha256);
  assert.equal(failure.size, f.object.size);
  assert.equal(failure.objects, f.input.refs.length);
  assert.equal(failure.stage, 'source-headers');
  // convexFetch types the thrown transport fault (aabe52a7); its URL never reaches the cause.
  assert.equal(failure.code, 'EXCHANGE_REQUEST_FAILED');
  assert(!JSON.stringify(failure).includes('private'));
});

test('a failed merge read reports storage as the slowest phase in its durable retry cause', async t => {
  const f = await failureFixture(t, 'calculate');
  f.fault('headers');
  let tick = 0;
  t.mock.method(performance, 'now', () => tick);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    tick += 55_000;
    return fetch(url, init);
  });

  await assert.rejects(f.run(), { name: 'SourceIoError' });

  const failure = f.calls.find(c => c.name.endsWith(':failed')).args.cause;
  assert.deepEqual(sourceFailureSchema.parse(failure), failure);
  assert.equal(failure.slowestPhase, 'read');
  assert.equal(failure.timing.readMs, 55_000);
  assert.deepEqual([failure.timing.gets, failure.timing.puts, failure.timing.heads], [1, 0, 0]);
  const logged = f.logs.find(line => line.event === 'forge-source-failure');
  assert.deepEqual(logged.timing, failure.timing);
  assert.equal(logged.slowestPhase, failure.slowestPhase);
});

test('fan-out completion returns the phase times and exact R2 request attempts', async t => {
  const f = await failureFixture(t, 'states');
  await f.run();
  const { timing } = f.completions()[0].args;
  const counts = f.r2.requests.reduce(
    (totals, method) => {
      totals[method]++;
      return totals;
    },
    { GET: 0, PUT: 0, HEAD: 0 },
  );
  assert.deepEqual([timing.gets, timing.puts, timing.heads], [counts.GET, counts.PUT, counts.HEAD]);
  assert(counts.GET > 0 && counts.PUT > 0 && counts.HEAD > 0);
  assert(['startupMs', 'readMs', 'computeMs', 'writeMs', 'convexMs'].every(phase => timing[phase] >= 0));
});
