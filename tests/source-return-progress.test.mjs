// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexExchange } from '../dist/exchange-client.js';
import { formatSourceReturnProgress } from '../dist/source-return-progress.js';
test('source return reports saved resume position and phase counters without changing the receipt', async () => {
  const exchange = Object.create(ConvexExchange.prototype),
    calls = [],
    events = [];
  const progress = { phase: 'views', step: 19, done: 5, total: 20, elapsedMs: 12000, etaSeconds: 30 };
  const receipt = { _id: 'receipt', revision: 42 };
  const replies = [
    { pending: true, resumed: true, progress: JSON.stringify(progress) },
    { pending: true, resumed: true, progress: JSON.stringify({ ...progress, step: 55, done: 10 }) },
    receipt,
  ];
  exchange.client = {
    action: async (_ref, args) => {
      calls.push(args);
      return replies.shift();
    },
  };
  exchange.projectId = 'project';
  exchange.onReturnProgress = e => events.push(e);
  assert.equal(await exchange.returnSource('new', 'previous', 40, 'operation'), receipt);
  assert.equal(calls[0].statusOnly, true);
  assert.equal(calls[1].statusOnly, undefined);
  assert.equal(events[0].resumed, true);
  assert.equal(events[1].resumed, false);
  assert.match(
    formatSourceReturnProgress(events[0]),
    /resuming from step 19\nsource return views: 5\/20 items \(step 19\), elapsed 12s, ETA 30s/,
  );
  assert.equal(events.at(-1).phase, 'complete');
  assert(calls.every(c => c.operationId === 'operation' && c.revision === 40));
});
test('completed source return prints the per-push storage accounting from its receipt', async () => {
  const exchange = Object.create(ConvexExchange.prototype),
    events = [];
  const accounting = { storageReads: 361, storageBytes: 8_604_532, steps: 43, invocations: 3 };
  const receipt = { _id: 'receipt', revision: 42, accounting };
  exchange.client = { action: async () => receipt };
  exchange.projectId = 'project';
  exchange.onReturnProgress = e => events.push(e);
  assert.equal(await exchange.returnSource('new', 'previous', 40, 'operation'), receipt);
  assert.equal(
    formatSourceReturnProgress(events.at(-1)).replace(/elapsed \d+s/, 'elapsed 0s'),
    'source return complete: elapsed 0s, 43 steps in 3 calls, 8.6 MB read from storage\n',
  );
  assert.equal(
    formatSourceReturnProgress({ ...events.at(-1), storageBytes: undefined }).replace(
      /elapsed \d+s/,
      'elapsed 0s',
    ),
    'source return complete: elapsed 0s\n',
  );
});

test('CLI probes saved inner progress while a long return action is still running and stops after completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const exchange = new ConvexExchange('https://test.convex.cloud', 'fixture', 'project', '', null);
  const events = [],
    calls = [];
  exchange.onReturnProgress = event => events.push(event);
  let complete;
  exchange.client.action = async (_ref, args) => {
    calls.push(args);
    if (args.statusOnly)
      return {
        pending: true,
        resumed: false,
        progress: JSON.stringify({
          phase: 'ancestry',
          done: 0,
          total: 1,
          step: 4,
          itemDone: 1000,
          itemPending: 1,
          elapsedMs: 30000,
          etaSeconds: null,
        }),
      };
    return new Promise(resolve => {
      complete = resolve;
    });
  };
  const running = exchange.returnSource('next', 'old', 0, 'op');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  assert.equal(events.at(-1).itemDone, 1000);
  complete({ revision: 1 });
  await running;
  t.mock.timers.tick(90000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
});
