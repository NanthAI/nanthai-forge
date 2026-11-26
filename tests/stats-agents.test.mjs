// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { statsAttribution } from '../dist/stats-agents.js';
import { statsDay, statsDaySchema } from '../dist/stats-estimate.js';
import { statsAllReply, statsMonth, statsMonthSchema, statsRangeReply } from '../dist/stats-period.js';

const at = Date.UTC(2026, 9, 1);
const landing = (receipt, i, values = {}) => ({
  id: String(i),
  attribution: statsAttribution(receipt),
  submittedAt: at,
  landedAt: at + 1000 * (i + 1),
  checkStartedAt: at,
  checkEndedAt: at,
  runnerSeconds: 60,
  discardedRunnerSeconds: 30,
  attempts: 1,
  ranInFull: false,
  ...values,
});
const batch = (n, receipt, values) => Array.from({ length: n }, (_, i) => landing(receipt, i, values));
const range = { from: '2026-10-01', to: '2026-10-31' };
const rowsOf = days => statsRangeReply(days, range, 'agents').agentRows;

test('the selected window groups agent runs by app and model and keeps people separate', () => {
  const codex = { agentClient: 'codex:gpt-6.2-sol', actor: { kind: 'agent', id: 'ada' } };
  const otherModel = { ...codex, agentClient: 'codex:gpt-6.2-astra' };
  const sameModelOtherApp = { ...codex, agentClient: 'antigravity:gpt-6.2-sol' };
  const person = id => ({ actor: { kind: 'person', id } });
  const attempts = [2, 2, 2, null, 2, 2];
  const codexRuns = attempts.map((attempt, i) =>
    landing({ ...codex, agentRun: `run-${i}` }, i, {
      attempts: attempt,
      discardedRunnerSeconds: i === 3 ? null : 30,
    }),
  );
  const one = statsDay(range.from, [
    ...codexRuns.slice(0, 3),
    ...batch(7, person('ada')),
    ...batch(5, otherModel),
    ...batch(5, sameModelOtherApp),
    ...batch(4, person('bea')),
  ]);
  const two = statsDay('2026-10-02', [
    ...codexRuns.slice(3),
    ...batch(5, { ...codex, agentClient: 'claude-code' }),
    landing({}, 2, { attempts: null, runnerSeconds: null }),
  ]);
  const rows = rowsOf([one, two]);
  assert.deepEqual(
    rows.map(r => r.landings),
    [7, 6, 5, 5, 5, 5],
  );
  assert.deepEqual(rows[0].identity, { kind: 'person', person: 'ada' });
  assert.deepEqual(rows[1], {
    identity: { kind: 'agent', app: 'codex', model: 'gpt-6.2-sol' },
    landings: 6,
    firstTryRate: 0,
    counted: 5,
    priced: 5,
    toMainSeconds: 3.5,
    timed: 6,
    approximate: false,
    ciMinutesPerLanding: 1.5,
    firstTryGap: 84,
  });
  assert(rows.some(r => r.identity.app === 'claude-code' && r.identity.model === null));
  assert(rows.some(r => r.identity.app === 'antigravity' && r.identity.model === 'gpt-6.2-sol'));
  assert(rows.some(r => r.identity.app === 'codex' && r.identity.model === 'gpt-6.2-astra'));
  const other = rows.find(r => r.identity.kind === 'other');
  assert.deepEqual(other.identity.reasons, { small: 4, legacy: 0, overflow: 0, unattributed: 1 });
  assert.equal(other.counted, 4);
  assert.equal(other.priced, 4);
});

test('old days and months keep their totals and name the missing attribution', () => {
  const day = statsDay(range.from, batch(6, { agentClient: 'claude-code:sonnet' }));
  const legacy = ({ byAgent, ...rest }) => ({ ...rest, who: [['a-run', 1, 1, 1]], others: 5 });
  const oldDay = statsDaySchema.parse(legacy(day));
  const month = statsMonth('2026-10', [day]);
  const oldMonth = statsMonthSchema.parse({ ...month, totals: legacy(month.totals) });
  const [only] = rowsOf([oldDay]);
  assert.deepEqual(only.identity, {
    kind: 'other',
    reasons: { small: 0, legacy: 6, overflow: 0, unattributed: 0 },
  });
  assert.deepEqual(
    [only.landings, only.firstTryRate, only.toMainSeconds, only.ciMinutesPerLanding],
    [6, 1, 3.5, 1.5],
  );
  assert.deepEqual(statsAllReply([oldMonth], [], 'agents').agentRows, [only]);
  const tails = [{ ...day, day: '2026-11-01' }];
  const current = statsAllReply([month], tails, 'agents').agentRows;
  assert.equal(current.length, 1);
  assert.equal(current[0].landings, 12);
  assert.deepEqual(current[0].identity, { kind: 'agent', app: 'claude-code', model: 'sonnet' });
});

test('the daily attribution bound accounts for every landing, including groups outside the stored summary', () => {
  const groups = Array.from({ length: 50 }, (_, i) => batch(5, { agentClient: `codex:model-${i}` })).flat();
  const rows = rowsOf([statsDay(range.from, groups)]);
  assert.equal(rows.length, 41);
  assert.equal(rows[0].landings, 50);
  assert.equal(rows[0].identity.reasons.overflow, 50);
  assert.equal(
    rows.reduce((n, row) => n + row.landings, 0),
    250,
  );
});
