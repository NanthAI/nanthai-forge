// SPDX-License-Identifier: Apache-2.0
// Local synthetic checks of the scripted queue scenarios; no bench, service or Git call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIOS,
  scenarioRole,
  scenarioTest,
  docEdit,
  landingReading,
  withdrawBody,
} from './scenarios.mjs';
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
    assert.match(scenarioTest('t1', kind, 240), /process\.env\.CI === "true" \?/);
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

test('the withdraw role waits for a running check and withdraws by submissionId when it has one', () => {
  const reply = (phase, timing = {}) => ({ result: { submission: { id: 's1', phase, timing } } });
  assert.deepEqual(landingReading(reply('queued')), { submissionId: 's1', running: false, over: false });
  assert.equal(landingReading(reply('checking')).running, true);
  assert.equal(landingReading(reply('queued', { checkReservedAt: 'x' })).running, true);
  assert.equal(landingReading(reply('queued', { checkReservedAt: 'x', ciEndedAt: 'y' })).running, false);
  assert.equal(landingReading(reply('landed')).over, true);
  assert.equal(
    landingReading({ result: { submissions: [{ submission: { id: 's2', phase: 'checking' } }] } })
      .submissionId,
    's2',
  );
  assert.deepEqual(landingReading({ error: { code: 'X' } }), {
    submissionId: null,
    running: false,
    over: false,
  });
  assert.deepEqual(withdrawBody('lane', 's1', 'r'), { submissionId: 's1', reason: 'r' });
  assert.deepEqual(withdrawBody('lane', null, 'r'), { laneId: 'lane', reason: 'r' });
});

test('a real checking landing reply starts the withdraw; the old status trigger never matched it', async () => {
  const { landingReading: read } = await import('./scenarios.mjs');
  // Shape of `landing {operationId}` while the check runs: no runId field anywhere.
  const reply = {
    result: {
      submission: { id: 's1', phase: 'checking', timing: { submittedAt: 'a', checkReservedAt: 'b' } },
    },
  };
  const text = JSON.stringify(reply.result);
  const oldTrigger = /"phase":"checking"/.test(text) && /"runId":"[^"]+"/.test(text);
  assert.equal(oldTrigger, false, 'the old trigger waited for a field the reply never has');
  assert.equal(read(reply).running, true);
});

test('scenario evidence voids a cell whose role did not fire and records group arrival order', async () => {
  const { scenarioEvidence, scenarioEvents } = await import('./scenario-evidence.mjs');
  const at = s =>
    `2026-01-01T00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
  const land = (task, s, verb = 'agent land --detail --save') => ({ task, verb, startedAt: at(s) });
  const records = [
    { task: 'w', dispatchedAt: at(0), changes: { files: [] } },
    { task: 'f', dispatchedAt: at(0), changes: { files: [] } },
    { task: 's', dispatchedAt: at(0), changes: { files: [{ path: 'README.md' }] } },
    { task: 'late', dispatchedAt: at(0), changes: { files: [] } },
  ];
  const roles = [
    { task: 'w', role: { withdrawOnce: true }, group: 'g' },
    { task: 'f', role: { failOnce: true }, group: 'g' },
    { task: 's', role: { slowSeconds: 240, doc: { path: 'README.md', at: 'top' } }, group: '' },
    { task: 'late', role: { releaseMs: 90_000 }, group: '' },
  ];
  const calls = [
    land('f', 3),
    land('w', 5),
    land('w', 700, 'agent land --detail --withdraw'),
    land('s', 1),
    land('late', 92),
  ];
  const events = line =>
    scenarioEvents(line.map(e => JSON.stringify({ event: 'scenario', ...e })).concat(['not json']));
  // The cells of 2026-11-18: withdraw refused, no failed check, short checks only.
  const bad = scenarioEvidence({
    roles,
    records,
    calls,
    jobs: [{ conclusion: 'success', startedAt: at(0), completedAt: at(150) }],
    events: { w: events([{ step: 'withdrawn', error: 'LANDING_NOT_LIVE' }]) },
  });
  assert.deepEqual(
    bad.problems.map(p => p.split(' (')[0]),
    [
      'scenario role did not fire: withdraw on w',
      'scenario role did not fire: fail-once on f',
      'scenario role did not fire: slow-check on s',
    ],
  );
  assert.deepEqual(bad.groupOrder, { g: ['f', 'w'] });
  const good = scenarioEvidence({
    roles,
    records,
    calls,
    jobs: [{ conclusion: 'success', startedAt: at(0), completedAt: at(400) }],
    events: {
      w: events([{ step: 'withdrawn', error: null }]),
      f: events([{ step: 'fix-after-failed-check' }]),
    },
  });
  assert.deepEqual(good.problems, []);
  assert.equal(good.roles.length, 5);
  const early = scenarioEvidence({ roles: [roles[3]], records, calls: [land('late', 10)], events: {} });
  assert.match(early.problems[0], /release on late/);
});
