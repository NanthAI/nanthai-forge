// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unknownCost } from '../dist/check-cost.js';
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
  assert.ok(!('startedAt' in record.lanes[0]));
  assert.equal(record.lanes[0].endedAt, T('10:10:00.000'));
  assert.deepEqual(
    record.lanes[0].saves.map(save => save.kind),
    ['save', 'sync'],
  );
  assert.ok(!('actor' in record.lanes[0].saves[0]));
  assert.deepEqual(record.runs[0], {
    cost: unknownCost('local'),
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
