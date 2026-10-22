// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSpend, SPEND_WINDOW_MS, configuredUsage } from '../dist/auto-exchange-spend.js';
const context = { projectId: 'synthetic', deployment: 'https://synthetic.invalid' };
const sample = (totalUsd, observedAt, extra = {}) => ({
  kind: 'measured',
  scope: 'team',
  subject: 'synthetic-team',
  ...context,
  observedAt,
  totalUsd,
  ...extra,
});

test('measured rolling spend pauses strictly above one dollar, expires and rebases', async () => {
  const start = 1_000_000;
  let state = await observeSpend(context, [], start, async () => sample(20, start));
  assert.equal(state.spend.deltaUsd, 0);
  for (const delta of [0.99, 1, 1.01]) {
    const next = await observeSpend(context, state.samples, start + 1, async () =>
      sample(20 + delta, start + 1),
    );
    assert.equal(next.spend.paused, delta > 1);
    assert.equal(next.spend.resumeAt, delta > 1 ? start + SPEND_WINDOW_MS : null);
  }
  state = await observeSpend(context, state.samples, start + 1, async () => sample(21.01, start + 1));
  const expired = await observeSpend(context, state.samples, start + SPEND_WINDOW_MS, async () =>
    sample(21.01, start + SPEND_WINDOW_MS),
  );
  assert.equal(expired.spend.paused, false);
  assert.equal(expired.spend.deltaUsd, 0);
});

test('missing, stale, delayed, cross-project and estimated observations never become measured spend', async () => {
  const now = SPEND_WINDOW_MS * 2;
  const baseline = [sample(1, now - 100)];
  const cases = [
    undefined,
    {},
    sample(3, now - SPEND_WINDOW_MS),
    sample(3, now + 1),
    sample(3, now - 200),
    sample(3, now, { projectId: 'other' }),
    sample(3, now, { deployment: 'https://other.invalid' }),
    sample(3, now, { kind: 'estimated' }),
    sample(3, now, { totalUsd: NaN }),
    sample(3, now, { totalUsd: -1 }),
  ];
  for (const input of cases) {
    const state = await observeSpend(context, baseline, now, async () => input);
    assert.equal(state.spend.paused, false);
    assert.notEqual(state.spend.availability, 'measured');
    assert.equal(state.spend.deltaUsd, null);
  }
});

test('counter reset and team change start a fresh baseline; duplicate observations do not invent spend', async () => {
  const previous = [sample(30, 100)];
  const reset = await observeSpend(context, previous, 200, async () => sample(2, 200));
  assert.equal(reset.spend.reason, 'reset');
  assert.equal(reset.spend.deltaUsd, 0);
  const changed = await observeSpend(context, previous, 200, async () =>
    sample(40, 200, { subject: 'another-team' }),
  );
  assert.equal(changed.spend.deltaUsd, 0);
  const same = await observeSpend(context, previous, 200, async () => sample(30, 100));
  assert.equal(same.samples.length, 1);
  const contradictory = await observeSpend(context, previous, 200, async () => sample(40, 100));
  assert.equal(contradictory.spend.availability, 'unknown');
});

test('unconfigured adapter is unknown without looking for accounts or tokens', async () => {
  const old = process.env.FORGE_CONVEX_USAGE_ADAPTER;
  delete process.env.FORGE_CONVEX_USAGE_ADAPTER;
  try {
    assert.equal(await configuredUsage(context), undefined);
  } finally {
    if (old !== undefined) process.env.FORGE_CONVEX_USAGE_ADAPTER = old;
  }
});
