// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDrillOwner } from '../scripts/phase5-hosted-lifecycle-fixture.mjs';
import { WorkStore } from '../dist/work-store.js';
import {
  measuredDrillClient,
  preflightHostedMachineDrill,
  dogfoodProject,
  callEstimate,
} from '../scripts/phase5-hosted-lifecycle-drill.mjs';
test('Q4 live preflight performs exactly one bounded read and no writes', async () => {
  const calls = [];
  const client = measuredDrillClient(
    {
      query: async (_ref, args) => {
        assert.deepEqual(args, { paginationOpts: { cursor: null, numItems: 1 } });
        return { page: [], isDone: true, continueCursor: '' };
      },
      mutation: () => assert.fail('preflight cannot mutate'),
      action: () => assert.fail('preflight cannot run actions'),
    },
    calls,
  );
  const result = await preflightHostedMachineDrill(client);
  assert.equal(result.readOnly, true);
  assert.equal(calls.length, 1);
  assert(callEstimate.total <= 2000);
});
test('Q4 live drill refuses dogfood before IO and leaves room for internal calls', async () => {
  let invoked = 0;
  const calls = [];
  const client = measuredDrillClient(
    {
      mutation: async () => {
        invoked++;
      },
    },
    calls,
  );
  const ref = makeFunctionReference('synthetic:mutation');
  await assert.rejects(client.mutation(ref, { projectId: dogfoodProject }));
  assert.equal(invoked, 0);
  calls.length = 2000 - callEstimate.serverInternalAllowance;
  await assert.rejects(client.mutation(ref, { projectId: 'synthetic-scratch' }));
  assert.equal(invoked, 0);
});
test('Q4 live preflight preserves current-auth failures without trying a write', async () => {
  const failure = Object.assign(Error('synthetic auth failure'), { code: 'AUTH_REQUIRED' });
  await assert.rejects(
    preflightHostedMachineDrill({
      query: async () => {
        throw failure;
      },
    }),
    error => error === failure,
  );
});
test('Q4 local live fixture has a real accepted main and scratch agent policy with the full gate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-q4-live-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const main = await prepareDrillOwner(root);
  const work = new WorkStore(root).load();
  assert.equal(work.channelMoves.at(-1).id, main.receiptId);
  assert.equal(work.channelMoves.at(-1).head, main.head);
  assert.equal(work.autonomyPolicy.acceptance.mode, 'auto-on-pass');
  assert.equal(work.autonomyPolicy.acceptance.gate, 'full');
  assert.equal(work.runs.length, 0, 'fixture creation runs no saved check');
  assert.equal(readFileSync(join(root, 'q4.txt'), 'utf8'), 'Q4 initial synthetic source\n');
});
