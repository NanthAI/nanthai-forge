// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import {
  plans,
  extraBlock,
  poolUsage,
  invoiceTotal,
  landingAllowance,
  remainingBudgetLine,
  planHeldLines,
} from '../web/src/billing/contract.ts';
const pool = (used, plan = 'hobby', cap = 0) => ({
  owner: { kind: 'person', handle: '@sample' },
  plan,
  period: { start: '2026-11-01', resetAt: '2026-12-01T00:00:00Z', label: 'November' },
  acceptedLandings: used,
  extraBlocksAllowed: cap,
  projectedLandings: null,
});
test('approved monthly plans and each started extra block use one price contract', () => {
  assert.deepEqual(
    Object.values(plans).map(p => [p.monthlyUsd, p.includedLandings]),
    [
      [0, 300],
      [15, 1000],
      [49, 5000],
    ],
  );
  assert.deepEqual(extraBlock, { landings: 500, usd: 10 });
  for (const [used, blocks] of [
    [1000, 0],
    [1001, 1],
    [1500, 1],
    [1501, 2],
  ]) {
    const usage = poolUsage(pool(used, 'pro', 2));
    assert.equal(usage.blocks, blocks);
    assert.equal(usage.extraUsd, blocks * 10);
    assert.equal(usage.remaining, 2000 - used);
  }
  assert.equal(poolUsage(pool(8000, 'team', null)).remaining, null);
});
test('remaining billing pool is shown strictly below 20 percent with the reset time', () => {
  assert.equal(remainingBudgetLine(landingAllowance(pool(240))), null);
  const line = remainingBudgetLine(landingAllowance(pool(241)));
  assert.match(line, /59 landings left/);
  assert.match(line, /2026-12-01T00:00:00Z/);
  assert.equal(remainingBudgetLine(landingAllowance(pool(1000, 'pro', null))), null);
});
test('plan-held stub names the automatic continuation without requiring a repeated landing', () => {
  const text = planHeldLines({
    kind: 'plan-held',
    owner: '@sample',
    used: 300,
    resumesAt: '2026-12-01T00:00:00Z',
    continuation: 'original landing operation',
    queuePosition: 2,
  });
  assert.match(text, /saved, position 2/);
  assert.match(text, /automatic continuation  original landing operation/);
  assert.match(text, /retry  not needed/);
});
test('invoice totals retain negative credits and tax without changing the plan prices', () => {
  assert.equal(invoiceTotal({ lines: [{ label: 'Credit', quantity: 1, unitUsd: -15 }], taxUsd: -3 }), -18);
});

const { createBillingStub, billingSample } = await import(moduleUrl('../web/src/billing/stub.ts'));
test('stub snapshots keep counts reconciled and financial data out of member pages', () => {
  for (const sample of ['first', 'hobby', 'pro', 'team', 'over', 'late', 'worst']) {
    const adapter = createBillingStub(sample);
    const { snapshot } = adapter.read();
    assert.equal(
      snapshot.projects.rows.reduce((n, p) => n + p.landings, 0),
      snapshot.pool.acceptedLandings,
    );
    assert(snapshot.months.length <= 12);
    assert(snapshot.projects.rows.length <= 50);
    assert(snapshot.invoices.rows.length <= 24);
    const member = createBillingStub(sample, 'member');
    assert.equal(member.read().snapshot.payment, null);
    assert.equal(member.read().snapshot.invoices, null);
    assert.equal(member.read().snapshot.nextInvoice, null);
    assert.deepEqual(member.invoices('0').rows, []);
  }
  const adapter = createBillingStub('worst');
  const first = adapter.read().snapshot.invoices;
  const next = adapter.invoices(first.nextCursor);
  assert.equal(first.rows.length, 24);
  assert.equal(next.rows.length, 6);
  assert.equal(new Set([...first.rows, ...next.rows].map(i => i.id)).size, 30);
  assert.equal(next.nextCursor, null);
  assert.equal(billingSample('unknown'), 'first');
  assert.equal(createBillingStub('pro', 'loading').read().status, 'loading');
  assert(createBillingStub('pro', 'error').read().previous);
});
test('remaining display rule uses the applicable pool ceiling including explicit extra blocks', () => {
  assert.equal(remainingBudgetLine(landingAllowance(pool(1600, 'pro', 2))), null);
  assert.match(remainingBudgetLine(landingAllowance(pool(1601, 'pro', 2))), /399 landings left/);
});
