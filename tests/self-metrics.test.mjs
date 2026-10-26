// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
import { selfMetricReuseKey } from '../dist/self-metrics-reuse-key.js';
const from = '2026-10-14T00:00:00.000Z',
  to = '2026-10-25T03:30:00.000Z';
const period = { from, to };
const at = (day, time = '12:00') => `2026-10-${day}T${time}:00.000Z`;
const input = (laneId, head, savedAt) => ({
  laneId,
  head,
  intentId: laneId,
  ...(savedAt ? { savedAt } : {}),
});
const base = () => ({
  moves: [],
  submissions: [],
  runs: [],
  receipts: [],
  gaps: [],
  coverage: { lifecycle: from, mutations: from, deliveries: from, checkRequests: from },
});
const submission = (id, at, inputs, status = 'queued', endedAt) => ({
  id,
  entryId: id,
  at,
  inputs,
  status,
  endedAt,
  progressAt: [],
  runIds: [],
});
const move = (id, at, inputs, kind = 'landing') => ({ id, at, head: `composed-${id}`, inputs, kind });
const receipt = (operationId, action, errorCode) => ({
  schema: 1,
  kind: 'lifecycle',
  operationId,
  action,
  errorCode,
  at: at('21', '19:25'),
  actor: { kind: 'agent', name: 'builder' },
  origin: 'command',
});

test('metric 1: hand-computed first try, same-head retry, fixer saved by another actor; UTC days and separate reverts', () => {
  const r = base();
  const first = input('a', 'a1', at('20', '09:00')),
    retry = input('b', 'b1', at('20', '09:00')),
    fix = input('c', 'c2', at('20', '13:01'));
  r.submissions = [
    submission('a0', at('20', '10:00'), [first], 'accepted'),
    submission('b0', at('20', '10:00'), [retry], 'failed', at('20', '11:00')),
    submission('b1', at('20', '12:00'), [retry], 'accepted'),
    submission('c0', at('20', '10:00'), [input('c', 'c1')], 'failed', at('20', '13:00')),
    submission('c1', at('20', '14:00'), [fix], 'accepted'),
  ];
  r.moves = [
    move('a', at('20', '15:00'), [first]),
    move('b', at('20', '16:00'), [retry]),
    move('c', at('21', '00:00'), [fix]),
    move('rev', at('21', '00:01'), [], 'revert'),
    move('comp', at('21', '00:02'), [], 'compensating'),
  ];
  const m = calculateSelfMetrics(r, period);
  assert.equal(m.landings, 3);
  assert.deepEqual(m.metric1.days, [
    { day: '2026-10-20', landings: 2, firstTry: 1, afterRetry: 1, afterFixer: 0, unknown: 0 },
    { day: '2026-10-21', landings: 1, firstTry: 0, afterRetry: 0, afterFixer: 1, unknown: 0 },
  ]);
  assert.equal(m.metric1.partial, false);
  assert.equal(m.metric1.reverts, 1);
  assert.equal(m.metric1.compensating, 1);
});
test('metric 1: earlier interrupted runs prevent first try; absent history is partial', () => {
  const r = base(),
    i = input('a', 'head');
  r.submissions = [submission('s', at('20'), [i], 'accepted')];
  r.runs = [{ id: 'r', at: at('19'), endedAt: at('19', '13:00'), status: 'interrupted', inputs: [i] }];
  r.moves = [move('m', at('21'), [i]), move('missing', at('22'), [input('b', 'head')])];
  const m = calculateSelfMetrics(r, period).metric1;
  assert.equal(m.partial, true);
  assert.equal(m.rows.filter(r => r.path === 'unknown').length, 2);
});
test('metric 2: Oct 21 incident shape, eight concurrent finishes return seven WORK_STALE, deduped by operation and code', () => {
  // STATE.md 2026-10-21 19:25: 7/8 finishes rejected during concurrent Work revision rechecks.
  const r = base();
  r.receipts = Array.from({ length: 8 }, (_, n) =>
    receipt(`finish-${n}`, 'finish', n ? 'WORK_STALE' : undefined),
  );
  r.receipts.push(receipt('finish-1', 'finish', 'WORK_STALE'), receipt('start', 'start', 'WORK_BUSY'));
  const m = calculateSelfMetrics(r, period).metric2;
  assert.equal(m.finishes, 8);
  assert.equal(m.errors, 8);
  assert.deepEqual(m.byCode, [
    { code: 'WORK_BUSY', count: 1, per100Finishes: 12.5, noOwner: null },
    { code: 'WORK_STALE', count: 7, per100Finishes: 87.5, noOwner: null },
  ]);
});
test('metric 3: Oct 23 leaderless batch, terminal undelivered failure and exact 60-minute threshold', () => {
  // STATE.md egress2 + friction.md: batch 811eb360 kept waiting after mates settled; land-ready returned finishes:[].
  const r = base(),
    asOf = at('23', '15:00');
  r.submissions = [
    submission('811eb360-egress2', at('23', '13:00'), [input('egress2', 'h')]),
    submission('recent', at('23', '14:01'), []),
    submission('threshold', at('23', '14:00'), []),
    submission('terminal', at('23', '13:00'), [], 'failed', at('23', '13:30')),
    submission('delivered', at('23', '13:00'), [], 'failed', at('23', '13:30')),
  ];
  r.submissions[0].noOwner = true;
  r.receipts = [
    {
      ...receipt('f', 'finish'),
      at: at('23', '13:31'),
      deliveries: [{ entryId: 'delivered', state: 'terminal-failed' }],
    },
  ];
  const m = calculateSelfMetrics(r, { ...period, asOf }).metric3;
  assert.equal(m.dropped, 3);
  assert.deepEqual(
    m.rows.map(s => s.id),
    ['811eb360-egress2', 'threshold', 'terminal'],
  );
  assert.equal(m.rows[0].noOwner, true);
});
test('metric 3: run/batch progress resets stall clock; landed input is settled, unrelated same head is not', () => {
  const r = base();
  const i = input('a', 'h');
  r.submissions = [
    submission('progress', at('23', '12:00'), []),
    submission('landed', at('23', '12:00'), [i]),
    submission('other', at('23', '12:00'), [input('b', 'h')]),
  ];
  r.submissions[0].runIds = ['run'];
  r.runs = [{ id: 'run', at: at('23', '14:30'), status: 'running', inputs: [] }];
  r.moves = [move('main', at('23', '13:00'), [i])];
  assert.deepEqual(
    calculateSelfMetrics(r, { ...period, asOf: at('23', '15:00') }).metric3.rows.map(s => s.id),
    ['other'],
  );
});
test('metric 5: commands counted once by requester; internal writes of finish and automatic writes excluded', () => {
  const r = base();
  r.moves = [move('m', at('22'), []), move('n', at('23'), [])];
  const mutation = (id, action, name, origin = 'command') => ({
    ...receipt(id, action),
    kind: 'mutation',
    origin,
    actor: { kind: origin === 'system' ? 'system' : 'person', name },
  });
  r.receipts = [
    mutation('cancel', 'cancel', 'lead'),
    mutation('cancel', 'cancel', 'lead'),
    mutation('policy', 'set-policy', 'owner'),
    mutation('sync', 'sync', 'lead'),
    mutation('finish', 'finish', 'builder'),
    mutation('auto', 'work-write', 'Forge', 'system'),
  ];
  const m = calculateSelfMetrics(r, period).metric5;
  assert.equal(m.interventions, 3);
  assert.equal(m.perLanding, 1.5);
  assert.deepEqual(m.byActor, [
    { actor: 'person:lead', count: 2, perLanding: 1 },
    { actor: 'person:owner', count: 1, perLanding: 0.5 },
  ]);
});
test('metric 6: sum physical shard minutes once including failed/interrupted/audit; reuse checks exact key', () => {
  const r = base();
  r.moves = [move('m', at('22'), []), move('n', at('23'), [])];
  const run = (id, status, wallMinutes, executions) => ({
    id,
    status,
    at: at('21'),
    endedAt: at('21', '12:05'),
    inputs: [],
    wallMinutes,
    executions,
    reuseKey: 'key',
  });
  r.runs = [
    run('pass', 'passed', 4, [
      { id: 'shard1', minutes: 3 },
      { id: 'shard2', minutes: 4 },
    ]),
    run('fail', 'failed', 2, [{ id: 'shard3', minutes: 2 }]),
    run('interrupted', 'interrupted', 1, [{ id: 'shard4', minutes: 1 }]),
    run('audit', 'passed', 2, [{ id: 'shard5', minutes: 2 }]),
    { ...run('reuse', 'passed', 0, []), reusedFrom: 'pass' },
    { ...run('adopt', 'failed', 1, [{ id: 'shard3', minutes: 2 }]) },
  ];
  const m = calculateSelfMetrics(r, period).metric6;
  assert.equal(m.runnerMinutes, 12);
  assert.equal(m.wallMinutes, 10);
  assert.equal(m.runnerMinutesPerLanding, 6);
  assert.equal(m.wallMinutesPerLanding, 5);
  assert.equal(m.reused, 1);
  assert.equal(m.fullChecksStarted, 5);
  assert.equal(m.reuseRate, 1 / 6);
  assert.equal(m.partial, false);
});
test('metric 6: reuse key ignores restart paths/runtime and Node patch, includes lockfile/minor/declared inputs', () => {
  const key = { tree: 'tree', definition: 'def', lockfile: 'lock', node: 'v24.22.1', declaredInputs: [] };
  assert.equal(
    selfMetricReuseKey(key),
    selfMetricReuseKey({ ...key, node: '24.22.9', installPath: '/other', runtime: 'changed' }),
  );
  for (const change of [
    { tree: 'different' },
    { definition: 'other' },
    { lockfile: 'other' },
    { node: '24.23.0' },
    { declaredInputs: ['changed'] },
  ])
    assert.notEqual(selfMetricReuseKey(key), selfMetricReuseKey({ ...key, ...change }));
  assert.equal(selfMetricReuseKey({ ...key, node: undefined }), undefined);
});
test('missing baseline records are partial and unknown, never zero; friction free text is ignored', () => {
  const r = base();
  delete r.coverage;
  r.gaps = ['friction prose not mined'];
  r.runs = [{ id: 'old', at: at('20'), status: 'interrupted', inputs: [] }];
  const m = calculateSelfMetrics(r, period);
  assert.equal(m.metric2.errors, null);
  assert.equal(m.metric2.finishes, null);
  assert.equal(m.metric3.dropped, null);
  assert.equal(m.metric5.interventions, null);
  assert.equal(m.metric6.runnerMinutes, null);
  assert.equal(m.metric6.reuseRate, null);
  for (const key of ['metric2', 'metric3', 'metric5', 'metric6']) {
    assert.equal(m[key].partial, true);
    assert.ok(m[key].gaps.length);
  }
});

test('metric 1 preserves durable submission order when timestamps tie', () => {
  const r = base();
  const first = input('a', 'first'),
    second = input('a', 'second');
  r.submissions = [
    submission('z-first', at('20'), [first], 'accepted'),
    submission('a-second', at('20'), [second], 'queued'),
  ];
  r.moves = [move('main', at('21'), [first])];
  assert.equal(calculateSelfMetrics(r, period).metric1.rows[0].path, 'first-try');
});

test('metric periods and day buckets compare instants in UTC, including timestamp offsets', () => {
  const r = base(),
    i = input('a', 'head');
  r.submissions = [submission('s', '2026-10-20T20:00:00-04:00', [i], 'accepted')];
  r.moves = [move('m', '2026-10-20T23:30:00-04:00', [i])];
  const m = calculateSelfMetrics(r, { from: '2026-10-21T00:00:00.000Z', to: '2026-10-22T00:00:00.000Z' });
  assert.equal(m.landings, 1);
  assert.equal(m.metric1.days[0].day, '2026-10-21');
  assert.equal(m.metric1.days[0].firstTry, 1);
});

test('operation and code counts are deduplicated before period selection across replay dates', () => {
  const r = base();
  const old = { ...receipt('f', 'finish', 'WORK_STALE'), at: at('20') },
    replay = { ...old, at: at('21') };
  const mutation = { ...receipt('cancel', 'cancel'), kind: 'mutation', at: at('20') };
  r.receipts = [old, replay, mutation, { ...mutation, at: at('21') }];
  const m = calculateSelfMetrics(r, { from: '2026-10-21T00:00:00.000Z', to: '2026-10-22T00:00:00.000Z' });
  assert.equal(m.metric2.finishes, 0);
  assert.equal(m.metric2.errors, 0);
  assert.equal(m.metric5.interventions, 0);
});
