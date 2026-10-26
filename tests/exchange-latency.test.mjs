// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { traceExchange, summarizeTrace } from '../scripts/measure-exchange-latency.mjs';

const fn = makeFunctionReference('projectObjects:missing');
test('measurement separates overlapping RPC elapsed time and preserves exact failed upload attempts without recording credentials', async () => {
  const nativeFetch = globalThis.fetch,
    snapshots = [];
  const fakeFetch = async () => {
    throw new Error('untrusted response may contain sensitive material');
  };
  globalThis.fetch = fakeFetch;
  const client = { query: async () => [], mutation: async () => null, action: async () => null },
    originalQuery = client.query;
  try {
    await assert.rejects(
      traceExchange(
        client,
        async phase => {
          await phase('missing', () => client.query(fn, { objects: [{ digest: 'a', size: 3 }] }));
          await phase('upload', () =>
            fetch('https://secret-upload.invalid', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-forge-object-private-nonce',
                Authorization: 'secret-token',
              },
              body: new Uint8Array([1, 2, 3]),
            }),
          );
        },
        { onProgress: trace => snapshots.push(trace) },
      ),
      /untrusted/,
    );
    const result = snapshots.at(-1);
    assert.equal(result.status, 'failed-or-unknown');
    assert.equal(result.summary.actualObjectPostBodyBytes, 3);
    assert.equal(result.summary.objectPostAttempts, 1);
    assert.equal(result.rpc[0].pins, 1);
    assert.equal(result.http[0].status, 'failed-or-unknown');
    assert.doesNotMatch(
      JSON.stringify(result),
      /secret-token|secret-upload|private-nonce|untrusted response/,
    );
    assert.equal(client.query, originalQuery);
    assert.equal(globalThis.fetch, fakeFetch);
    assert.equal(result.phases[1].status, 'failed-or-unknown');
  } finally {
    globalThis.fetch = nativeFetch;
  }
  const summary = summarizeTrace({
    rpc: [
      { method: 'query', name: 'read', status: 'ok', startMs: 0, durationMs: 10, pins: 100 },
      { method: 'query', name: 'read', status: 'ok', startMs: 5, durationMs: 10, pins: 20 },
      { method: 'action', name: 'publish', status: 'ok', startMs: 20, durationMs: 5 },
    ],
    http: [],
  });
  assert.equal(summary.rpcUnionMs, 20);
  assert.equal(summary.rpc[0].totalMs, 20);
  assert.equal(summary.rpc[0].pins, 120);
});

test('successful trace restores transport methods and records results once', async () => {
  const client = { query: async () => [], mutation: async () => null, action: async () => 'original-backup' };
  const original = client.action,
    rows = [];
  const trace = await traceExchange(
    client,
    phase =>
      phase('publish', () => client.action(makeFunctionReference('projectExchangeActions:publish'), {})),
    { onProgress: value => rows.push(value) },
  );
  assert.equal(trace.result, 'original-backup');
  assert.equal(trace.summary.rpcCalls, 1);
  assert.equal(rows.at(-1).status, 'passed');
  assert.equal(client.action, original);
});

test('upload attempt is durably reported before the fetch promise settles', async () => {
  const original = globalThis.fetch,
    snapshots = [];
  let release;
  globalThis.fetch = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const client = { query: async () => [], mutation: async () => null, action: async () => null };
  try {
    const pending = traceExchange(
      client,
      async () => {
        await fetch('https://fixture.invalid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-forge-object-fixture' },
          body: new Uint8Array(7),
        });
        return null;
      },
      { onProgress: trace => snapshots.push(trace) },
    );
    const started = snapshots.at(-1).http[0];
    assert.equal(started.status, 'started');
    assert.equal(started.requestBodyBytes, 7);
    assert.equal(started.durationMs, undefined);
    release(new Response(null, { status: 200 }));
    await pending;
    assert(snapshots.some(trace => trace.status === 'started' && trace.http[0]?.status === 'http-200'));
    assert.equal(snapshots.at(-1).summary.actualObjectPostBodyBytes, 7);
  } finally {
    globalThis.fetch = original;
  }
});
