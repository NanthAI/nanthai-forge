// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { exchangeConvexFetch } from '../dist/exchange-convex-fetch.js';
import { withCheckoutOpenMetrics } from '../dist/checkout-open-metrics.js';
import {
  checkoutPrepObservation,
  withCheckoutPrepObservation,
  measureCheckoutRpc,
} from '../dist/checkout-prep-observation.js';

test('open receipt attributes startup and full RPC wall including failed calls without extra requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-prep-observation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    clock += 7;
    return new Response(JSON.stringify({ status: 'success', value: 42 }));
  });
  const client = deadlineConvexClient('https://synthetic.convex.cloud', {
    logger: false,
    fetch: exchangeConvexFetch({ retries: 0 }),
  });
  const root = join(dir, 'lane');
  const request = { laneId: randomUUID(), operationId: randomUUID() };
  const failure = new Error('synthetic refusal');
  await withCheckoutPrepObservation(
    () =>
      withCheckoutOpenMetrics(root, request, async () => {
        assert.equal(
          await client.query(makeFunctionReference('fixture:read'), { privateInput: 'never retained' }),
          42,
        );
        await assert.rejects(
          measureCheckoutRpc('fixture:failed', async () => {
            clock += 3;
            throw failure;
          }),
          e => e === failure,
        );
      }),
    120,
  );
  const text = readFileSync(root + '.forge-metrics.jsonl', 'utf8');
  const { checkout } = JSON.parse(text);
  assert.equal(requests, 1);
  assert.equal(checkout.prep.startupMs, 120);
  assert.equal(checkout.prep.rpcAttempts, 1);
  assert.deepEqual(checkout.prep.rpc, [
    { name: 'fixture:read', calls: 1, wallMs: 7, failed: 0 },
    { name: 'fixture:failed', calls: 1, wallMs: 3, failed: 1 },
  ]);
  assert(!text.includes('never retained'));
  assert.equal(checkoutPrepObservation(), undefined);
});

test('concurrent prep observations remain separate and direct callers retain unknown startup', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const a = withCheckoutPrepObservation(async () => {
    await measureCheckoutRpc('fixture:first', () => gate);
    return checkoutPrepObservation();
  }, 1);
  const b = await withCheckoutPrepObservation(async () => {
    await measureCheckoutRpc('fixture:second', async () => 42);
    return withCheckoutPrepObservation(async () => checkoutPrepObservation());
  });
  release();
  const first = await a;
  assert.equal(first.startupMs, 1);
  assert.equal(b.startupMs, null);
  assert.deepEqual(
    first.rpc.map(row => [row.name, row.calls]),
    [['fixture:first', 1]],
  );
  assert.deepEqual(
    b.rpc.map(row => [row.name, row.calls]),
    [['fixture:second', 1]],
  );
  first.rpc[0].calls = 99;
  assert.equal(checkoutPrepObservation(), undefined);
});

test('freshness RPCs before hosted dispatch stay in the open observation', async () => {
  const result = await withCheckoutPrepObservation(async () => {
    await measureCheckoutRpc('fixture:release', async () => 42);
    return withCheckoutPrepObservation(async () => checkoutPrepObservation(), 25);
  });
  assert.equal(result.startupMs, 25);
  assert.deepEqual(
    result.rpc.map(row => [row.name, row.calls]),
    [['fixture:release', 1]],
  );
});
