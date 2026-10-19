// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { trustAgents } from './autonomy-fixture.mjs';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { readHostState } from '../dist/host-binding.js';
import { ACTIVE_IDLE_MS, activeMs, deriveMakingOf, runTiming, unionMs } from '../dist/making-of.js';

const T = iso => `2026-10-17T${iso}Z`;
const oid = c => c.repeat(64);
const intent = (extra = {}) => ({
  id: 'i-1',
  outcome: 'Add search',
  constraints: '',
  base: oid('a'),
  status: 'active',
  notes: [],
  createdAt: T('10:00:00.000'),
  ...extra,
});
const lane = (id, extra = {}) => ({
  id,
  intentId: 'i-1',
  name: id,
  base: oid('a'),
  head: oid('b'),
  assignment: '',
  target: '',
  state: 'active',
  checkpoints: [],
  ...extra,
});
const run = (id, extra = {}) => ({
  id,
  viewId: 'v-1',
  head: oid('b'),
  base: oid('a'),
  inputs: [],
  dependencies: [],
  check: { id: 'c', name: 'verify' },
  status: 'passed',
  runner: { pid: 1, host: 'machine' },
  details: '',
  ...extra,
});
const empty = { lanes: [], views: [], runs: [], moves: [], presence: [], reports: [] };

test('run timing splits queue from running time and omits what was not recorded', () => {
  // Spawned: startedAt moved forward when the command started.
  assert.deepEqual(
    runTiming(
      run('a', {
        queuedAt: T('10:00:00.000'),
        startedAt: T('10:00:30.000'),
        endedAt: T('10:02:30.000'),
        childPid: 9,
      }),
    ),
    { queuedMs: 30_000, runningMs: 120_000, durationMs: 150_000 },
  );
  // Cancelled before spawn: all time was queue/preparation; no running time is invented.
  assert.deepEqual(
    runTiming(
      run('b', {
        status: 'cancelled',
        queuedAt: T('10:00:00.000'),
        startedAt: T('10:00:00.000'),
        endedAt: T('10:00:05.000'),
      }),
    ),
    { queuedMs: 5_000, durationMs: 5_000 },
  );
  // Legacy run without queuedAt: only the total is known.
  assert.deepEqual(
    runTiming(run('c', { startedAt: T('10:00:00.000'), endedAt: T('10:01:00.000'), childPid: 9 })),
    { durationMs: 60_000 },
  );
  // Still running: queue time is known, running and total are not.
  assert.deepEqual(
    runTiming(
      run('d', {
        status: 'running',
        queuedAt: T('10:00:00.000'),
        startedAt: T('10:00:10.000'),
        childPid: 9,
      }),
    ),
    { queuedMs: 10_000 },
  );
  assert.deepEqual(
    runTiming(run('e', { status: 'queued', queuedAt: T('10:00:00.000'), startedAt: T('10:00:00.000') })),
    {},
  );
});

test('interval union and active-time gaps', () => {
  assert.equal(unionMs([]), 0);
  assert.equal(
    unionMs([
      [0, 10],
      [5, 20],
      [30, 40],
      [32, 35],
    ]),
    30,
  );
  assert.equal(
    activeMs([0, 60_000, 60_000 + ACTIVE_IDLE_MS, 60_000 + ACTIVE_IDLE_MS + 1 + ACTIVE_IDLE_MS]),
    60_000 + ACTIVE_IDLE_MS,
  );
});

test('an Intent with no Lanes or runs reports empty records and omits every derived number', () => {
  const record = deriveMakingOf({ ...empty, intent: intent() });
  assert.deepEqual(record, {
    intentId: 'i-1',
    outcome: 'Add search',
    status: 'active',
    createdAt: T('10:00:00.000'),
    actors: [],
    lanes: [],
    runs: [],
    landings: [],
  });
});

test('one Lane, one run and one landing: timings, actors and advisory sources', () => {
  const record = deriveMakingOf({
    intent: intent({
      status: 'completed',
      agentStart: { id: randomUUID(), request: oid('c'), laneId: 'l-1' },
    }),
    lanes: [
      lane('l-1', {
        state: 'completed',
        startedBy: { kind: 'agent', name: 'claude-i1', tool: 'claude-code' },
        checkpoints: [
          { head: oid('b'), parent: oid('a'), message: 'Search API', at: T('10:05:00.000') },
          {
            head: oid('d'),
            parent: oid('b'),
            message: 'Sync main',
            at: T('10:06:00.000'),
            sync: { channel: 'main', target: oid('e'), changedPaths: [] },
          },
        ],
        lifecycle: [{ from: 'active', to: 'completed', at: T('10:10:00.000') }],
      }),
    ],
    views: [
      {
        id: 'v-1',
        intentId: 'i-1',
        base: oid('a'),
        inputs: [],
        status: 'clean',
        details: '',
        at: T('10:06:30.000'),
      },
    ],
    runs: [
      run('r-1', {
        queuedAt: T('10:06:30.000'),
        startedAt: T('10:07:00.000'),
        endedAt: T('10:09:00.000'),
        childPid: 5,
        checkSelection: { scope: 'full', reason: '', tests: [] },
      }),
    ],
    moves: [
      {
        id: 'm-1',
        channel: 'main',
        viewId: 'v-1',
        head: oid('d'),
        previous: oid('a'),
        at: T('10:09:30.000'),
        status: 'accepted',
        provenance: 'user-declared-local',
        acceptedBy: { kind: 'agent', name: 'claude-i1', tool: 'claude-code' },
      },
    ],
    presence: [
      {
        name: 'claude-i1',
        environment: 'Local Lane',
        status: 'completed',
        lastSeen: Date.parse(T('10:09:30.000')),
        lastActivity: Date.parse(T('10:09:30.000')),
        context: { laneId: 'l-1', intentId: 'i-1' },
      },
    ],
    reports: [
      {
        laneId: 'l-1',
        intentId: 'i-1',
        name: 'claude-i1',
        model: 'claude-opus-5-5',
        tokens: { input: 1000, output: 200 },
        reportedAt: T('10:09:40.000'),
      },
    ],
  });
  assert.equal(record.lanes[0].startedAt, T('10:00:00.000'));
  assert.equal(record.lanes[0].endedAt, T('10:10:00.000'));
  assert.deepEqual(
    record.lanes[0].saves.map(save => save.kind),
    ['save', 'sync'],
  );
  assert.ok(!('actor' in record.lanes[0].saves[0]));
  assert.deepEqual(record.runs[0], {
    runId: 'r-1',
    viewId: 'v-1',
    check: 'verify',
    status: 'passed',
    scope: 'full',
    queuedAt: T('10:06:30.000'),
    startedAt: T('10:07:00.000'),
    endedAt: T('10:09:00.000'),
    queuedMs: 30_000,
    runningMs: 120_000,
    durationMs: 150_000,
  });
  assert.deepEqual(record.checks, {
    runs: 1,
    finished: 1,
    queuedMs: 30_000,
    runningMs: 120_000,
    durationMs: 150_000,
    waitingMs: 150_000,
  });
  assert.equal(record.wallClockMs, 10 * 60_000);
  assert.equal(record.firstEventAt, T('10:00:00.000'));
  assert.equal(record.lastEventAt, T('10:10:00.000'));
  // 10:00 → 10:05 → 10:06 → … → 10:10: no gap exceeds the idle threshold.
  assert.equal(record.activeTime.ms, 10 * 60_000);
  assert.equal(record.landings.length, 1);
  assert.deepEqual(record.landings[0].acceptedBy, { name: 'claude-i1', kind: 'agent', tool: 'claude-code' });
  assert.deepEqual(record.actors, [
    { name: 'claude-i1', kind: 'agent', harness: ['claude-code'], model: ['claude-opus-5-5'] },
  ]);
  assert.deepEqual(record.tokens, { input: 1000, output: 200, reports: 1 });
  assert.equal(record.sessions[0].lastActivityAt, T('10:09:30.000'));
});

test('several Lanes and runs: parallel waits count once, legacy runs add only totals, idle gaps are excluded', () => {
  const record = deriveMakingOf({
    ...empty,
    intent: intent(),
    lanes: [
      lane('l-1', {
        checkpoints: [{ head: oid('b'), parent: oid('a'), message: 'API', at: T('10:01:00.000') }],
      }),
      lane('l-2', {
        checkpoints: [{ head: oid('c'), parent: oid('a'), message: 'UI', at: T('12:00:00.000') }],
      }),
    ],
    runs: [
      run('r-1', {
        queuedAt: T('12:00:00.000'),
        startedAt: T('12:01:00.000'),
        endedAt: T('12:05:00.000'),
        childPid: 1,
      }),
      run('r-2', {
        queuedAt: T('12:02:00.000'),
        startedAt: T('12:03:00.000'),
        endedAt: T('12:06:00.000'),
        childPid: 2,
      }),
      run('r-3', { status: 'failed', startedAt: T('11:00:00.000'), endedAt: T('11:01:00.000'), childPid: 3 }),
      run('r-4', { status: 'running', queuedAt: T('12:10:00.000'), startedAt: T('12:10:00.000') }),
    ],
    reports: [
      { laneId: 'l-1', intentId: 'i-1', name: 'a', tokens: { input: 10 }, reportedAt: T('12:00:00.000') },
      {
        laneId: 'l-2',
        intentId: 'i-1',
        name: 'b',
        tokens: { input: 5, output: 7 },
        reportedAt: T('12:00:01.000'),
      },
      {
        laneId: 'l-2',
        intentId: 'i-1',
        name: 'b',
        sessionId: 's2',
        harness: 'codex',
        reportedAt: T('12:00:02.000'),
      },
    ],
  });
  assert.deepEqual(
    record.runs.map(item => item.runId),
    ['r-3', 'r-1', 'r-2', 'r-4'],
  );
  assert.ok(
    !('scope' in record.runs[0]) && !('queuedAt' in record.runs[0]) && !('queuedMs' in record.runs[0]),
  );
  assert.ok(!('endedAt' in record.runs[3]) && !('durationMs' in record.runs[3]));
  assert.deepEqual(record.checks, {
    runs: 4,
    finished: 3,
    queuedMs: 120_000,
    runningMs: 420_000,
    durationMs: 60_000 + 300_000 + 240_000,
    // 11:00–11:01 plus the union 12:00–12:06.
    waitingMs: 60_000 + 360_000,
  });
  assert.equal(record.wallClockMs, Date.parse(T('12:10:00.000')) - Date.parse(T('10:00:00.000')));
  // Only gaps ≤15 minutes count: 10:00→10:01, 11:00→11:01, then 12:00…12:10.
  assert.equal(record.activeTime.ms, 60_000 + 60_000 + 10 * 60_000);
  assert.deepEqual(record.tokens, { input: 15, output: 7, reports: 2 });
  assert.deepEqual(record.actors, [{ name: 'a' }, { name: 'b', harness: ['codex'] }]);
  assert.ok(!('sessions' in record));
  assert.deepEqual(record.landings, []);
});

test('agent making-of and report actions over a native owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-making-of-'));
  try {
    writeFileSync(join(root, 'file.txt'), 'original\n');
    initNative(root);
    trustAgents(root);
    const agent = new AgentWorkflow(root);
    const started = (
      await agent.dispatch({
        action: 'start',
        outcome: 'Change greeting',
        actor: 'claude-i1',
        tool: 'claude-code',
      })
    ).result;
    const planned = (await agent.dispatch({ action: 'making-of', intentId: started.intentId })).result;
    assert.equal(planned.lanes.length, 1);
    assert.equal(planned.lanes[0].startedAt, planned.createdAt);
    assert.deepEqual(planned.runs, []);
    assert.ok(!('checks' in planned) && !('tokens' in planned));
    writeFileSync(join(started.path, 'file.txt'), 'changed\n');
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', "require('fs').readFileSync('file.txt','utf8')==='changed\\n'||process.exit(1)"],
    });
    const finished = (
      await agent.dispatch({ action: 'finish', laneId: started.laneId, message: 'Greeting', accept: true })
    ).result;
    assert.equal(finished.status, 'accepted');

    const report = {
      action: 'report',
      operationId: randomUUID(),
      laneId: started.laneId,
      actor: 'claude-i1',
      model: 'claude-opus-5-5',
      tokens: { input: 100, output: 20 },
    };
    const first = (await agent.dispatch(report)).result;
    assert.equal(first.report.name, 'claude-i1');
    const newer = { ...report, operationId: randomUUID(), tokens: { input: 300, output: 50 } };
    await agent.dispatch(newer);
    // Replaying an older operation never overwrites newer totals.
    assert.deepEqual((await agent.dispatch(report)).result.report.tokens, { input: 300, output: 50 });
    assert.equal(Object.keys(readHostState(agent.work.store).selfReports).length, 1);
    await assert.rejects(
      agent.dispatch({ action: 'report', laneId: started.laneId }),
      error => error.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(
      agent.dispatch({ action: 'report', laneId: randomUUID(), model: 'm' }),
      error => error.code === 'NOT_FOUND',
    );

    const record = (await agent.dispatch({ action: 'making-of', intentId: started.intentId })).result;
    assert.equal(record.status, 'completed');
    assert.deepEqual(
      record.lanes[0].saves.map(save => save.kind),
      ['save'],
    );
    assert.equal(record.runs.length, 1);
    const [checked] = record.runs;
    assert.equal(checked.status, 'passed');
    for (const key of ['queuedMs', 'runningMs', 'durationMs'])
      assert.ok(Number.isInteger(checked[key]) && checked[key] >= 0, key);
    assert.equal(checked.queuedMs + checked.runningMs, checked.durationMs);
    assert.equal(record.landings.length, 1);
    assert.equal(record.landings[0].channel, 'main');
    assert.deepEqual(record.tokens, { input: 300, output: 50, reports: 1 });
    assert.deepEqual(record.actors.find(row => row.name === 'claude-i1')?.model, ['claude-opus-5-5']);
    assert.ok(record.wallClockMs >= 0 && record.activeTime.ms <= record.wallClockMs);
    assert.ok(!('operations' in record.reports[0]));
    await assert.rejects(
      agent.dispatch({ action: 'making-of', intentId: randomUUID() }),
      error => error.code === 'NOT_FOUND',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('infrastructure outcomes end recorded timing without inventing a local spawn', () => {
  for (const status of ['runner-unavailable', 'runner-budget-exhausted'])
    assert.deepEqual(
      runTiming(
        run('infra', {
          status,
          queuedAt: T('10:00:00.000'),
          startedAt: T('10:00:00.000'),
          endedAt: T('10:00:05.000'),
        }),
      ),
      { queuedMs: 5_000, durationMs: 5_000 },
    );
});
