// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ModalSourceProvider } from '../dist/modal-source-provider.js';
import { readSourceControlReply } from '../dist/hosted-source-control-reply.js';
import { sourceWorkerHttp } from '../dist/hosted-source-worker-http.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';

const input = {
  schema: 1,
  projectId: 'synthetic',
  jobId: randomUUID(),
  operationId: randomUUID(),
  jobKind: 'save',
  attempt: 1,
  fence: 1,
  authorityEpoch: 1,
  input: { sha256: 'a'.repeat(64), size: 32 },
  inputDigest: 'a'.repeat(64),
  provider: 'modal',
  worker: 'forge-source-v1',
  runtime: 'b'.repeat(64),
  dispatchKey: 'c'.repeat(64),
};
const config = {
  endpoint: 'https://synthetic.modal.run/source',
  token: 'synthetic-only',
  worker: input.worker,
  runtime: input.runtime,
  timeoutMs: 1000,
};
const response = result =>
  new Response(JSON.stringify({ dispatchKey: input.dispatchKey, input: canonicalPayload(input), result }));

test('Modal acknowledgements bind stable key and complete immutable dispatch; no underlying retry', async () => {
  let count = 0;
  const provider = new ModalSourceProvider({
    ...config,
    async fetch(url, init) {
      count++;
      assert.equal(url, config.endpoint);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer synthetic-only');
      assert.deepEqual(JSON.parse(init.body), { action: 'dispatch', input });
      return response({ status: 'accepted', executionId: 'fc-synthetic' });
    },
  });
  assert.deepEqual(await provider.dispatch(input), { status: 'accepted', executionId: 'fc-synthetic' });
  assert.equal(count, 1);
  for (const patch of [{ provider: 'actions' }, { worker: 'project-code' }, { runtime: 'd'.repeat(64) }])
    await assert.rejects(
      provider.dispatch({ ...input, ...patch }),
      e => e.code === 'SOURCE_PROVIDER_CHANGED',
    );
  assert.equal(count, 1);
});

test('HTTP errors, timeouts, unbound and non-definitive replies retain dispatch ambiguity', async () => {
  for (const fetch of [
    async () => {
      throw new Error('timeout');
    },
    async () => new Response('', { status: 400 }),
    async () => response({ status: 'rejected' }),
    async () => response({ status: 'empty', authoritative: false }),
    async () =>
      new Response(
        JSON.stringify({
          dispatchKey: 'forged',
          input: canonicalPayload(input),
          result: { status: 'accepted', executionId: 'fc-other' },
        }),
      ),
    async () =>
      new Response(
        JSON.stringify({
          dispatchKey: input.dispatchKey,
          input: 'changed',
          result: { status: 'accepted', executionId: 'fc-other' },
        }),
      ),
  ]) {
    let calls = 0;
    const provider = new ModalSourceProvider({
      ...config,
      fetch: async (...args) => {
        calls++;
        return fetch(...args);
      },
    });
    assert.deepEqual(await provider.dispatch(input), { status: 'unknown' });
    assert.deepEqual(await provider.lookup(input), { status: 'unknown' });
    assert.equal(calls, 2);
  }
});

test('only explicit definitive rejection or authoritative exact lookup is accepted', async () => {
  for (const [result, expected] of [
    [
      { status: 'empty', authoritative: true },
      { status: 'empty', authoritative: true },
    ],
    [
      { status: 'found', executionId: 'fc-synthetic' },
      { status: 'found', executionId: 'fc-synthetic' },
    ],
    [{ status: 'accepted', executionId: 'fc-synthetic' }, { status: 'unknown' }],
  ])
    assert.deepEqual(
      await new ModalSourceProvider({ ...config, fetch: async () => response(result) }).lookup(input),
      expected,
    );
  assert.deepEqual(
    await new ModalSourceProvider({
      ...config,
      fetch: async () => response({ status: 'rejected', definitive: true }),
    }).dispatch(input),
    { status: 'rejected' },
  );
});

test('direct object transfers use newly authorized exact grants and never forward control credentials to R2', async () => {
  const calls = [],
    bytes = Buffer.from('synthetic source');
  const http = sourceWorkerHttp({
    endpoint: 'https://control.invalid/source/',
    token: 'control-secret',
    executionId: 'fc-test',
    input,
    timeoutMs: 1000,
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/grant')) {
        const value = JSON.parse(init.body);
        assert.deepEqual(value.pin, input.input);
        assert.deepEqual(value.input, input);
        return new Response(JSON.stringify({ url: `https://r2.invalid/${value.action}` }));
      }
      if (String(url).endsWith('/commit')) return new Response('{}');
      assert.equal(init.headers?.authorization, undefined);
      if (init.method === 'PUT') {
        const parts = [];
        for await (const part of init.body) parts.push(part);
        assert.deepEqual(Buffer.concat(parts), bytes);
        return new Response('');
      }
      return new Response(bytes);
    },
  });
  const chunks = [];
  for await (const part of await http.transport.read(input.input)) chunks.push(part);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await http.transport.upload(
    input.input,
    (async function* () {
      yield bytes;
    })(),
  );
  assert.equal(calls.length, 5);
});

test('revoked, redirected, malformed or unsafe grants cannot fetch source or acknowledge output', async () => {
  for (const reply of [
    new Response('', { status: 403 }),
    new Response(JSON.stringify({ url: 'http://unsafe.invalid' })),
    new Response('{}'),
  ]) {
    let calls = 0;
    const http = sourceWorkerHttp({
      endpoint: 'https://control.invalid/',
      token: 'synthetic',
      executionId: 'fc-test',
      input,
      timeoutMs: 1000,
      async fetch() {
        calls++;
        return reply;
      },
    });
    await assert.rejects(http.transport.read(input.input));
    assert.equal(calls, 1);
  }
});

test('control metadata is bounded before parsing regardless of declared length or invalid UTF-8', async () => {
  await assert.rejects(
    readSourceControlReply(new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-length': '1' } })),
    e => e.code === 'SOURCE_PAGE_INVALID',
  );
  await assert.rejects(readSourceControlReply(new Response(new Uint8Array([0xff, 0xfe]))));
  assert.deepEqual(await readSourceControlReply(new Response('{"ok":true}')), { ok: true });
});

test('create-only output PUTs retain signed headers and reconcile 412 only after acknowledged commit', async () => {
  for (const commitStatus of [200, 403]) {
    let commits = 0;
    const http = sourceWorkerHttp({
      endpoint: 'https://control.invalid/',
      token: 'synthetic',
      executionId: 'fc-test',
      input,
      timeoutMs: 1000,
      async fetch(url, init) {
        if (String(url).endsWith('/grant'))
          return new Response(
            JSON.stringify({
              url: 'https://r2.invalid/output',
              headers: {
                'if-none-match': '*',
                'x-amz-checksum-sha256': 'synthetic-checksum',
                'content-length': '0',
              },
            }),
          );
        if (String(url).endsWith('/commit')) {
          commits++;
          return new Response('{}', { status: commitStatus });
        }
        assert.equal(init.headers['if-none-match'], '*');
        assert.equal(init.headers['x-amz-checksum-sha256'], 'synthetic-checksum');
        assert.equal(init.headers.authorization, undefined);
        return new Response('', { status: 412 });
      },
    });
    const attempt = http.transport.upload(input.input, (async function* () {})());
    if (commitStatus === 200) await attempt;
    else await assert.rejects(attempt, e => e.code === 'SOURCE_WORKER_UNAVAILABLE');
    assert.equal(commits, 1);
  }
});
