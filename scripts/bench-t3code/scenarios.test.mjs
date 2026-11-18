// SPDX-License-Identifier: Apache-2.0
// Local synthetic checks of the scripted queue scenarios; no bench, service or Git call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, scenarioRole, scenarioTest, docEdit } from './scenarios.mjs';
import { driveForge } from './forge-protocol.mjs';
import { summarizeCell, passToLand } from './scenario-report.mjs';
import { switchProblems } from './switches.mjs';

test('smoke keeps the unchanged dry run: no role at any position', () => {
  for (let i = 0; i < 10; i++) assert.deepEqual(scenarioRole('smoke', i), {});
});

test('every scenario names the switch paths it exercises and is the same in every arm', () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    assert.ok(Array.isArray(s.paths) && s.about, name);
    const roles = Array.from({ length: 10 }, (_, i) => scenarioRole(name, i));
    assert.deepEqual(
      roles,
      Array.from({ length: 10 }, (_, i) => scenarioRole(name, i)),
    );
    assert.ok(!JSON.stringify(roles).includes('FORGE_'), 'no role depends on a switch');
  }
  assert.deepEqual(scenarioRole('main-move', 3), { releaseMs: 60_000 });
  assert.equal(scenarioRole('parked-head', 0).slowSeconds, 240);
  assert.equal(scenarioRole('parked-head', 5).releaseMs, 20_000);
  assert.throws(() => scenarioRole('nope', 0), /unknown scenario/);
});

test('scenario files: a failing test, its fix, a slow test, and far-apart same-file edits', () => {
  assert.match(scenarioTest('t1', 'fail'), /toBe\("fixed"\)/);
  assert.match(scenarioTest('t1', 'fail'), /"fails once"/);
  assert.doesNotMatch(scenarioTest('t1', 'fixed'), /fails once/);
  assert.match(scenarioTest('t1', 'slow', 240), /240000/);
  // Failure and slowness show only in the hosted landing check, never in the local preflight.
  for (const kind of ['fail', 'slow'])
    assert.match(scenarioTest('t1', kind, 240), /process\.env\.GITHUB_ACTIONS === "true" \?/);
  const text = 'a\nb\n';
  assert.equal(docEdit(text, 't1', 'top'), '<!-- bench scenario t1 -->\n\na\nb\n');
  assert.equal(docEdit(text, 't2', 'bottom'), 'a\nb\n<!-- bench scenario t2 -->\n');
});

test('a failed check calls the scenario fix once, then lands again', async () => {
  const replies = [
    { error: { code: 'CHECK_FAILED', message: 'check failed' } },
    { result: { submission: { phase: 'landed' } } },
  ];
  const calls = [];
  let fixes = 0;
  const result = await driveForge({
    root: '/tmp/lane',
    laneId: 'lane',
    message: 'dry',
    call: async command => (calls.push(command), replies.shift()),
    pause: async () => {},
    onFailure: async () => (++fixes, fixes === 1),
  });
  assert.equal(fixes, 1);
  assert.equal(result.landAttempts, 2);
  assert.deepEqual(
    calls.map(c => [c.action, c.flags]),
    [
      ['land', ['--save']],
      ['land', ['--save']],
    ],
  );
});

test('without a scenario hook a failed check stays a product failure (smoke unchanged)', async () => {
  await assert.rejects(
    driveForge({
      root: '/tmp/lane',
      laneId: 'lane',
      message: 'dry',
      call: async () => ({ error: { code: 'CHECK_FAILED', message: 'check failed' } }),
      pause: async () => {},
    }),
    /BENCH_PRODUCT_FRICTION/,
  );
});

test('report joins only the cell receipts and reads pass-to-land from the first passed check', () => {
  const receipt = (laneId, from, committedAt, extra = {}) => ({
    laneId,
    committedAt,
    heldAfterCheck: [{ from, to: committedAt }],
    recomposeCount: 1,
    costs: { attempts: 2, runnerAccepted: 10, runnerDiscarded: 5 },
    ...extra,
  });
  assert.equal(passToLand(receipt('a', '2026-01-01T00:00:00Z', '2026-01-01T00:01:40Z')), 100);
  const row = summarizeCell(
    {
      cellId: 'c',
      landed: 2,
      scenario: { name: 'cohort-fail' },
      switches: { start: { X: true } },
      records: [{ laneId: 'a' }, { laneId: 'b' }],
      convex: { projectExecutions: 40, costUsd: 0.01 },
    },
    [
      receipt('a', '2026-01-01T00:00:00Z', '2026-01-01T00:01:40Z'),
      receipt('b', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z'),
      receipt('other', '2026-01-01T00:00:00Z', '2026-01-01T09:00:00Z'),
    ],
  );
  assert.equal(row.receipts, 2);
  assert.equal(row.passToLandP50, 200);
  assert.equal(row.attemptsPerLanding, 2);
  assert.equal(row.recompositions, 2);
  assert.equal(row.wastePercent, (100 * 10) / 30);
  assert.equal(row.convexUsdPer1000, 5);
  assert.deepEqual(row.switches, { X: true });
});

test('a switch that is unreadable or changes during a cell voids it', () => {
  assert.deepEqual(switchProblems({ A: true }, { A: true }), []);
  assert.deepEqual(switchProblems({ A: true }, { A: false }), ['switch A changed during cell']);
  assert.deepEqual(switchProblems({ A: null }, { A: true }), ['switch A unreadable']);
});
