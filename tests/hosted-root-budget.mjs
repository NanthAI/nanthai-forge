// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import { convexToJson, jsonToConvex } from 'convex/values';
import { childEnv } from '../scripts/child-env.mjs';
export async function measureRootBudget(t, f) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      if (url.pathname === '/r2') {
        const upstream = await fetch(url.searchParams.get('url'), {
          headers: { 'accept-encoding': 'identity' },
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status);
        response.end(bytes);
        return;
      }
      assert(['/api/query', '/api/mutation'].includes(url.pathname));
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks)),
        args = jsonToConvex(body.args[0]);
      const value = await f.exchange.client[url.pathname === '/api/query' ? 'query' : 'mutation'](
        makeFunctionReference(body.path),
        args,
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'success', value: convexToJson(value) }));
    } catch (error) {
      response.writeHead(560, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'error', errorMessage: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const privateHome = join(f.root, '..', 'home');
  mkdirSync(privateHome);
  const run = async args => {
    const started = performance.now();
    const output = await promisify(execFile)(
      process.execPath,
      [resolve('tests/hosted-root-cli-process.mjs'), ...args],
      {
        env: childEnv({
          extra: {
            HOME: privateHome,
            XDG_CONFIG_HOME: join(privateHome, '.config'),
            FORGE_AUTH_TOKEN: 'synthetic-fixture-only',
            FORGE_TEST_CHECKOUT_PROXY: origin,
          },
        }),
      },
    );
    return {
      result: JSON.parse(output.stdout),
      wallMs: Math.round(performance.now() - started),
      ...JSON.parse(output.stderr.trim().split('\n').at(-1)),
    };
  };
  const cloned = await run(['clone', 'project', f.root, '--deployment', origin]);
  const cloneCalls = f.calls.length,
    cloneDocuments = f.documents();
  // A dispatched request may lose its connection before reaching the fixture.
  // Keep the budget on actual client attempts, including those failed requests.
  assert(cloned.rpcCalls >= cloneCalls);
  const started = await run(['agent', f.root, 'start', JSON.stringify({ outcome: 'Warm cache start' })]);
  assert.equal(started.result.result.checkout.downloadedObjects, 0);
  const calls = f.calls.length;
  assert(started.rpcCalls >= calls - cloneCalls);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, calls, 'no calls after the CLI exits');
  return {
    files: f.files.length,
    sourceBytes: f.sourceBytes,
    cloneCalls: cloned.rpcCalls,
    cloneMs: cloned.wallMs,
    clonePeakRssMiB: cloned.peakRssMiB,
    cloneSampledMemory: cloned.sampledMemory,
    startCalls: started.rpcCalls,
    startMs: started.wallMs,
    startPeakRssMiB: started.peakRssMiB,
    startSampledMemory: started.sampledMemory,
    cloneDocuments,
    startDocuments: {
      read: f.documents().read - cloneDocuments.read,
      written: f.documents().written - cloneDocuments.written,
    },
    r2Gets: f.fake.requests.filter(r => r.method === 'GET').length,
    idleCalls: 0,
    liveCostUsd: 0,
  };
}
