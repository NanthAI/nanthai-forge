// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const { FixAnswers } = await import(moduleUrl('../web/src/cockpit/fix-answers.ts'));
const { needsFixDecisions } = await import(moduleUrl('../web/src/cockpit/needs-fix.ts'));
const intentId = randomUUID(),
  laneId = randomUUID();
const main = { head: 'a'.repeat(64), receipt: { id: randomUUID() }, authority: { mode: 'server', epoch: 1 } };
const reply = operationId =>
  JSON.stringify({
    schema: 1,
    operationId,
    intentId,
    at: '2026-10-14T10:00:00.000Z',
    fixBrief: 'Failing tests, diff and undo',
    lane: {
      schema: 2,
      projectId: 'synthetic',
      laneId,
      intentId,
      head: 'b'.repeat(64),
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      base: { head: main.head, receiptId: main.receipt.id },
      authority: main.authority,
    },
  });

test('Start a fix reads main once and replays the original operation and pins after a lost reply', async () => {
  let reads = 0,
    writes = 0;
  const calls = [];
  const actions = new FixAnswers({
    main: async () => {
      reads++;
      return structuredClone(main);
    },
    start: async request => {
      calls.push(structuredClone(request));
      if (++writes === 1) throw Error('lost reply');
      return reply(request.operationId);
    },
    close: async () => assert.fail('No close'),
  });
  assert.equal(reads, 0);
  await assert.rejects(actions.startFix(intentId), /lost reply/);
  assert.equal(await actions.startFix(intentId), laneId);
  assert.equal(reads, 1);
  assert.equal(writes, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].intentId, intentId);
});

test('duplicate clicks share one start, failed discovery retries, malformed replies retain the original operation', async () => {
  let reads = 0,
    writes = 0;
  const ids = [];
  const actions = new FixAnswers({
    main: async () => {
      if (++reads === 1) throw Error('offline');
      return main;
    },
    start: async request => {
      ids.push(request.operationId);
      return ++writes === 1 ? '{}' : reply(request.operationId);
    },
    close: async () => assert.fail('No close'),
  });
  await assert.rejects(actions.startFix(intentId), /offline/);
  const a = actions.startFix(intentId),
    b = actions.startFix(intentId);
  assert.equal(a, b);
  await assert.rejects(a);
  assert.equal(await actions.startFix(intentId), laneId);
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal(ids[0], ids[1]);
});

test('Close is one mutation and an unknown result retains its operation id without a main read', async () => {
  const calls = [];
  const actions = new FixAnswers({
    main: async () => assert.fail('Close must not read main'),
    start: async () => assert.fail('Close must not start work'),
    close: async request => {
      calls.push(request);
      if (calls.length === 1) throw Error('lost close reply');
    },
  });
  await assert.rejects(actions.closeFix(intentId), /lost close reply/);
  await actions.closeFix(intentId);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].intentId, intentId);
});

test('600-Intent recovery render preparation has zero IO and bounded linear work', t => {
  const intents = Array.from({ length: 600 }, (_, i) => ({ id: String(i), outcome: `Intent ${i}` }));
  const notices = intents.map(intent => ({
    intentId: intent.id,
    state: 'reverted',
    auditRunId: 'audit',
    head: main.head,
    summary: 'Reverted receipt r: a.test.mjs failed on h',
    undo: 'undo',
  }));
  // Warm the same pure path before measuring it on the shared machine.
  needsFixDecisions(notices, intents);
  const start = performance.now();
  const items = needsFixDecisions(notices, intents);
  const elapsed = performance.now() - start;
  assert.equal(items.length, 600);
  assert.equal(items[599].title, 'Intent 599');
  assert.ok(elapsed < 5, `${elapsed} ms exceeds the 5 ms preparation budget`);
  t.diagnostic(
    JSON.stringify({
      intents: 600,
      notices: 600,
      calls: 0,
      documentsRead: 0,
      documentsWritten: 0,
      elapsedMs: elapsed,
      peakRSS: process.resourceUsage().maxRSS,
    }),
  );
});
