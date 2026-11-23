// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Billing screens on stubs (Items 1fbf61b9, 989c5695, 7f9a23e8, 176db9fb): previews and the retry-safe action contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const preview = await import(moduleUrl('../web/src/billing/preview.ts'));
const { createBillingActions } = await import(moduleUrl('../web/src/billing/actions.ts'));
const { createBillingStub, billingSamples } = await import(moduleUrl('../web/src/billing/stub.ts'));
const pool = (plan, used, projected = used * 2, cap = plan === 'hobby' ? 0 : 2) => ({
  owner: { kind: 'person', handle: '@sample' },
  plan,
  period: {
    start: '2026-11-01T00:00:00Z',
    resetAt: '2026-12-01T00:00:00Z',
    asOf: '2026-11-16T00:00:00Z',
    label: 'November',
  },
  acceptedLandings: used,
  extraBlocksAllowed: cap,
  projectedLandings: projected,
});

test('a mid-month move up pays the days left and gets the full included landings at once', () => {
  const up = preview.planChange(pool('hobby', 286), 'pro');
  assert.equal(up.direction, 'up');
  assert.equal(up.starts, '2026-11-16T00:00:00Z');
  assert.deepEqual([up.daysCharged, up.daysInPeriod], [15, 30]);
  assert.equal(up.newPlanUsd, 7.5);
  assert.equal(up.chargedTodayUsd, 7.5);
  assert.deepEqual([up.includedNow, up.remainingNow], [1000, 714]);
  const team = preview.planChange(pool('pro', 1712), 'team');
  assert.equal(team.creditUsd, 7.5, 'the paid days of the current plan are credited');
  assert.equal(team.chargedTodayUsd, 17);
  assert.equal(team.droppedBlocks, 2, 'blocks the new plan covers are dropped');
});

test('a move down waits for the reset and charges nothing today', () => {
  const down = preview.planChange(pool('team', 783), 'pro');
  assert.equal(down.direction, 'down');
  assert.equal(down.starts, '2026-12-01T00:00:00Z');
  assert.equal(down.chargedTodayUsd, 0);
  assert.equal(down.includedNow, 5000, 'the current plan stays until the paid month ends');
});

test('a cheaper plan at the account’s own pace is named in either direction', () => {
  assert.deepEqual(preview.cheaperPlan(pool('pro', 1654)), { plan: 'team', savesUsd: 16 });
  assert.deepEqual(preview.cheaperPlan(pool('team', 783)), { plan: 'pro', savesUsd: 14 });
  assert.deepEqual(preview.cheaperPlan(pool('hobby', 286)), { plan: 'pro', savesUsd: null });
  assert.equal(preview.cheaperPlan(pool('pro', 746)), null);
  assert.match(
    preview.paceAssumption(pool('pro', 746)),
    /746 landings in the first 15 days.*1,492 landings by month end/,
  );
});

test('the extra-landings limit states the monthly maximum; no limit has none', () => {
  assert.deepEqual(preview.monthlyMaximum('pro', 2), { waitsAt: 2000, maxUsd: 35 });
  assert.deepEqual(preview.monthlyMaximum('team', 0), { waitsAt: 5000, maxUsd: 49 });
  assert.deepEqual(preview.monthlyMaximum('pro', null), { waitsAt: null, maxUsd: null });
  assert.deepEqual(preview.monthlyMaximum('hobby', 5), { waitsAt: 300, maxUsd: 0 });
  for (const sample of ['pro', 'team', 'over'])
    assert.equal(
      createBillingStub(sample).read().snapshot.pool.extraBlocksAllowed,
      2,
      'default of two blocks',
    );
});

test('a limit approaching is judged from pace to reset, not a fixed percentage', () => {
  const near = preview.limitPace(pool('hobby', 286, 572));
  assert.equal(near.kind, 'near');
  assert.equal(near.left, 14);
  assert.equal(preview.whenWords(near), 'today');
  assert.equal(preview.limitPace(pool('hobby', 250, 260)).kind, 'fine', '83% used but the pace stays inside');
  assert.equal(preview.limitPace(pool('hobby', 60, 600)).kind, 'near', '20% used but the pace passes it');
  assert.equal(preview.limitPace(pool('hobby', 300)).kind, 'reached', 'Hobby has no grace landing');
  assert.equal(preview.limitPace(pool('pro', 1200, 2400, null)).kind, 'no-limit');
});

test('failed payment retries on days 1, 4 and 8, landings continue 21 days, then the Hobby allowance', () => {
  const r = preview.paymentRecovery('2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z');
  assert.deepEqual(
    r.attempts.map(a => [a.day, a.at.slice(0, 10), a.done]),
    [
      [1, '2026-11-01', true],
      [4, '2026-11-04', true],
      [8, '2026-11-08', false],
    ],
  );
  assert.equal(r.landingsUntil.slice(0, 10), '2026-11-22');
  assert.deepEqual(r.then, { plan: 'hobby', included: 300 });
});

test('held work reads the same on every surface and needs no resubmission', () => {
  const story = preview.heldStory(pool('hobby', 300), 2);
  for (const line of [story.row, story.lane, story.tell, story.agent(2)]) assert.match(line, /@sample/);
  assert.match(story.lane, /In queue/);
  assert.match(story.lane, /no check runs, so no CI minutes are spent/);
  assert.match(story.tell, /300 landings for November/);
  assert.match(story.agent(2), /position 2 in the queue/);
  assert.match(story.agent(2), /retry  not needed/);
  assert.match(story.agent(2), /original landing operation/);
  assert.equal(story.waiting, '2 Lanes wait at In queue with their places kept');
  assert.match(preview.heldStory(pool('pro', 2000), 1).lane, /2 extra blocks @sample allowed/);
});

test('checkout reconciles on the same operation instead of charging twice', () => {
  const actions = createBillingActions({ checkout: 'unknown' });
  const first = actions.checkout({ operationId: 'op-1', to: 'pro' });
  assert.equal(first.state, 'unknown');
  assert.equal(
    actions.checkout({ operationId: 'op-1', to: 'pro' }),
    first,
    'a repeated id returns the same attempt',
  );
  assert.equal(actions.reconcile('op-1').attempts, 1);
  assert.equal(actions.settle('op-1', 'paid').attempts, 1);
  assert.equal(actions.reconcile('op-1').state, 'paid');
  assert.equal(first.handoffUrl, null, 'P7 has no hosted payment page');
});

test('failed billing edits keep what was typed and retry on the same operation', () => {
  const actions = createBillingActions({ correctionFailsOnce: true });
  const request = {
    operationId: 'c-1',
    invoiceId: 'SAMPLE-0004',
    field: 'taxId',
    text: 'Use the new tax ID',
  };
  const failed = actions.requestCorrection(request);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'provider-unavailable');
  assert.equal(actions.requestCorrection(request).ok, true);
  const details = { billedTo: 'Example', country: '', postcode: '', address: '', taxId: 'XX123', copyTo: '' };
  const invalid = actions.saveDetails({ operationId: 'd-1', details });
  assert.deepEqual([invalid.ok, invalid.field], [false, 'taxId']);
  assert.equal(
    actions.saveDetails({ operationId: 'd-1', details: { ...details, taxId: 'NL123456789B01' } }).ok,
    true,
  );
  assert.deepEqual(actions.download('SAMPLE-0004'), { status: 'unavailable', reason: 'sample' });
});

test('billing managers get invoices, plan and card; members get none of them', () => {
  for (const sample of billingSamples) {
    const manager = createBillingStub(sample, 'manager').read().snapshot;
    const owner = createBillingStub(sample, 'owner').read().snapshot;
    assert.equal(manager.view, 'manager');
    assert.deepEqual(manager.invoices, owner.invoices);
    assert.deepEqual(manager.payment, owner.payment);
  }
  const late = createBillingStub('late').read().snapshot;
  assert.deepEqual(
    late.invoices.rows.map(i => i.state),
    ['unpaid', 'paid', 'refunded', 'paid'],
  );
  assert.equal(late.payment.firstDeclinedAt, '2026-11-01T00:00:00Z');
});
