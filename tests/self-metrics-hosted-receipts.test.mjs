// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from '../dist/errors.js';
import {
  callerReceipts,
  clearCallerReceipts,
  metricOutboxDirectory,
  takeCallerReceipts,
  writeCallerReceipts,
} from '../dist/hosted-metric-outbox.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { landingFixture, api, code } from './hosted-landing-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { fixture, period, at } from './self-metrics-hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const priority = await import(moduleUrl('../convex/projectHostedLandingPriority.ts'));
const autonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));

const now = () => new Date().toISOString();
const outcome = (overrides = {}) => ({
  kind: 'outcome',
  actor: 'owner',
  at: now(),
  action: 'finish',
  operationId: randomUUID(),
  errorCodes: ['WORK_STALE'],
  noOwner: false,
  noOwnerCause: null,
  ...overrides,
});
const receiptRows = f =>
  [...(f.tables.projectSelfMetricReceipts?.values() ?? [])].map(({ _id, _creationTime, ...row }) => row);

test('caller receipts ride on a successful CLI mutation, bound to its project and authenticated requester', async () => {
  const f = await landingFixture();
  const mine = outcome(),
    delivery = {
      kind: 'delivery',
      actor: null,
      at: now(),
      action: 'observe',
      operationId: null,
      entryId: randomUUID(),
      state: 'terminal-failed',
      noOwner: true,
      noOwnerCause: 'check worker at checking',
    };
  const carried = [
    mine,
    delivery,
    outcome({ actor: 'stranger' }),
    outcome({ at: '2099-01-01T00:00:00.000Z' }),
    { kind: 'outcome', action: 'finish' },
  ];
  const enqueue = (request, metricReceipts) =>
    f.call(
      'landingEnqueue',
      api.enqueue,
      { projectId: f.projectId, request: JSON.stringify(request), metricReceipts },
      'owner',
    );
  const request = f.request();
  await enqueue(request, JSON.stringify(carried));
  const rows = receiptRows(f);
  assert.deepEqual(rows.map(row => row.kind).sort(), ['delivery', 'outcome']);
  assert(rows.every(row => row.projectId === f.projectId && row.actor === 'owner'));
  assert.deepEqual(JSON.parse(rows.find(row => row.kind === 'outcome').value), {
    action: 'finish',
    errorCodes: ['WORK_STALE'],
    noOwner: false,
    noOwnerCause: null,
    operationId: mine.operationId,
  });
  assert.equal(rows.find(row => row.kind === 'delivery').actor, 'owner', 'unknown actor binds to auth');
  // A replay of the same mutation and receipts is one row per visible outcome.
  await enqueue(request, JSON.stringify(carried));
  await enqueue(f.request(), 'not json');
  assert.equal(receiptRows(f).length, rows.length);
  // A refused host mutation rolls back its receipts too; receipts never fail it.
  await assert.rejects(enqueue({ ...f.request(), authorityEpoch: 9 }, JSON.stringify([outcome()])));
  assert.equal(receiptRows(f).length, rows.length);
});

test('every owner intervention has its own timestamped receipt, including repeated priority changes', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const change = (expectedVersion, value) =>
    f.call(
      'priorityChange',
      priority.prioritize,
      {
        projectId: f.projectId,
        submissionId: state.id,
        operationId: randomUUID(),
        priority: value,
        authorityEpoch: 1,
        expectedVersion,
      },
      'owner',
    );
  await change(0, 'urgent');
  await change(1, 'normal');
  await change(2, 'urgent');
  const policy = randomUUID();
  await f.call(
    'setPolicy',
    autonomy.set,
    { projectId: f.projectId, command: JSON.stringify({ action: 'set-policy', operationId: policy }) },
    'owner',
  );
  await f.call(
    'setPolicy',
    autonomy.set,
    { projectId: f.projectId, command: JSON.stringify({ action: 'set-policy', operationId: policy }) },
    'owner',
  );
  const mutations = receiptRows(f).filter(row => row.kind === 'mutation');
  assert.deepEqual(
    mutations.map(row => JSON.parse(row.value).action),
    ['prioritize', 'prioritize', 'prioritize', 'set-policy'],
  );
  assert.equal(new Set(mutations.map(row => row.key)).size, 4);
  assert(mutations.every(row => row.actor === 'owner' && Number.isFinite(Date.parse(row.at))));
  assert.equal(receiptRows(f).length, 4, 'no rows besides the receipts themselves');
});

test('caller receipts record what the caller received, with no-owner cause, and the outbox is idempotent', t => {
  const operationId = randomUUID(),
    id = randomUUID();
  const submission = {
    id,
    operationId,
    phase: 'terminal-failed',
    error: { code: 'LANDING_STALLED' },
    observation: {
      state: 'terminal-failed',
      stall: { missingOwner: 'check worker', step: 'checking' },
    },
  };
  const finished = callerReceipts({
    action: 'finish',
    operationId,
    actor: 'owner',
    at: now(),
    result: { phase: 'finish', submission },
  });
  assert.deepEqual(
    finished.map(r => [r.kind, r.action, r.noOwner, r.noOwnerCause]),
    [
      ['outcome', 'finish', true, 'check worker at checking'],
      ['delivery', 'finish', true, 'check worker at checking'],
    ],
  );
  assert.deepEqual(finished[0].errorCodes, ['LANDING_STALLED']);
  const failed = callerReceipts({
    action: 'save',
    operationId,
    actor: null,
    at: now(),
    error: new ForgeError('WORK_STALE', 'stale'),
  });
  assert.deepEqual(
    failed.map(r => [r.action, r.errorCodes]),
    [['checkpoint', ['WORK_STALE']]],
  );
  assert.equal(
    callerReceipts({ action: 'observe', operationId: null, actor: 'owner', at: now(), result: [submission] })
      .length,
    1,
    'observation records a delivery, never a lifecycle outcome',
  );
  assert.equal(
    callerReceipts({ action: 'compose', operationId, actor: 'owner', at: now(), result: {} }).length,
    0,
  );
  const directory = metricOutboxDirectory({ url: 'https://outbox.invalid', projectId: randomUUID() });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeCallerReceipts(directory, finished);
  writeCallerReceipts(directory, finished);
  writeCallerReceipts(directory, [{ ...finished[0], actor: 'stranger', operationId: randomUUID() }]);
  writeFileSync(join(directory, '0-malformed.json'), '{');
  assert.equal(readdirSync(directory).length, 4);
  const taken = takeCallerReceipts(directory, 'owner');
  assert.equal(JSON.parse(taken.payload).length, 2);
  clearCallerReceipts(taken.files);
  assert.equal(readdirSync(directory).length, 1, 'only the other requester remains');
  for (let i = 0; i < 25; i++) writeCallerReceipts(directory, [outcome({ operationId: randomUUID() })]);
  assert.equal(JSON.parse(takeCallerReceipts(directory, 'owner').payload).length, 20);
});

test('a later existing CLI mutation carries pending receipts; unsupported servers get no new argument', async t => {
  const f = agentFixture(t);
  const directory = metricOutboxDirectory({ url: 'https://fixture.invalid', projectId: 'project' });
  rmSync(directory, { recursive: true, force: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const starts = () => f.calls.filter(call => call.name === 'projectHostedStart:start');
  await f.transport().dispatch('start', { operationId: randomUUID(), outcome: 'Old server' });
  await f.transport().dispatch('start', { operationId: randomUUID(), outcome: 'Old server again' });
  assert(starts().every(call => call.args.metricReceipts === undefined));
  rmSync(directory, { recursive: true, force: true });
  f.caps.metricReceiptVersion = 1;
  const first = randomUUID();
  let before = f.calls.length;
  await f.transport().dispatch('start', { operationId: first, outcome: 'Receipt server' });
  const plain = f.calls.length - before;
  assert.equal(starts().at(-1).args.metricReceipts, undefined, 'nothing pending yet');
  assert.equal(readdirSync(directory).length, 1);
  const refused = randomUUID();
  await assert.rejects(
    f.transport().dispatch('start', { operationId: refused, unexpected: true }),
    code('BAD_ARGUMENT'),
  );
  before = f.calls.length;
  await f.transport().dispatch('start', { operationId: randomUUID(), outcome: 'Carry' });
  assert.equal(f.calls.length - before, plain, 'no extra call carries receipts');
  const carried = JSON.parse(starts().at(-1).args.metricReceipts);
  assert.deepEqual(
    carried.map(r => [r.action, r.operationId, r.errorCodes]).sort((a, b) => a[2].length - b[2].length),
    [
      ['start', first, []],
      ['start', refused, ['BAD_ARGUMENT']],
    ],
  );
  assert.equal(readdirSync(directory).length, 1, 'carried receipts are cleared; the new outcome waits');
});

test('hosted reader makes 5.2, 5.3 and 5.5 complete after collection starts and partial for unreported callers', async () => {
  const f = fixture();
  const receipt = (kind, actor, time, value, key = randomUUID()) =>
    f.put(
      'projectSelfMetricReceipts',
      { projectId: 'project', key, kind, actor, at: time, value: JSON.stringify(value) },
      time,
    );
  const request = (id, time, phase, extra = {}) =>
    f.put(
      'projectHostedLandingRequests',
      {
        projectId: 'project',
        channel: 'main',
        submissionId: id,
        operationId: id,
        actor: 'agent',
        sequence: 0,
        runnable: false,
        phase,
        runId: null,
        attemptId: id,
        value: JSON.stringify({ id, operationId: id, at: time, phase, error: null, ...extra }),
      },
      time,
    );
  // The earliest receipt of each kind is that metric's collection start.
  receipt('outcome', 'agent', at(-60), {
    action: 'start',
    operationId: randomUUID(),
    errorCodes: [],
    noOwner: false,
    noOwnerCause: null,
  });
  receipt('delivery', 'agent', at(-60), {
    action: 'observe',
    operationId: null,
    entryId: randomUUID(),
    state: 'landed',
    noOwner: false,
    noOwnerCause: null,
  });
  receipt('mutation', 'owner', at(-60), { action: 'cancel', operationId: randomUUID() });
  f.landing('landed', at(10), at(20));
  const failed = randomUUID(),
    dropped = randomUUID();
  request(failed, at(30), 'terminal-failed', { error: { code: 'CHECK_FAILED' } });
  request(dropped, at(40), 'terminal-failed', {
    observation: { stall: { missingOwner: 'batch driver', step: 'composing' } },
  });
  for (const [id, codes] of [
    ['landed', []],
    [failed, ['CHECK_FAILED']],
    [dropped, ['LANDING_STALLED']],
  ])
    receipt('outcome', 'agent', at(41), {
      action: 'finish',
      operationId: id,
      errorCodes: codes,
      noOwner: codes.includes('LANDING_STALLED'),
      noOwnerCause: codes.includes('LANDING_STALLED') ? 'LANDING_STALLED' : null,
    });
  receipt('delivery', 'agent', at(50), {
    action: 'finish',
    operationId: failed,
    entryId: failed,
    state: 'terminal-failed',
    noOwner: false,
    noOwnerCause: null,
  });
  for (const [action, minutes] of [
    ['prioritize', 11],
    ['prioritize', 12],
    ['cancel', 13],
    ['set-policy', 14],
  ])
    receipt('mutation', 'owner', at(minutes), { action, operationId: randomUUID() });
  const window = { from: at(0), to: at(600) };
  const read = async () => metricsSurface((await readHostedMetricPages(f.query, window)).records, window);
  let totals = (await read()).totals;
  assert.equal(totals['5.2'].partial, false, totals['5.2'].gaps.join('; '));
  assert.equal(totals['5.2'].finishes, 3);
  assert.deepEqual(
    totals['5.2'].byCode.map(row => [row.code, row.count, row.noOwner]),
    [
      ['CHECK_FAILED', 1, null],
      ['LANDING_STALLED', 1, 1],
    ],
  );
  assert.equal(totals['5.3'].partial, false, totals['5.3'].gaps.join('; '));
  assert.deepEqual(
    totals['5.3'].rows.map(row => [row.entryId, row.noOwner]),
    [[dropped, true]],
  );
  assert.equal(totals['5.5'].partial, false, totals['5.5'].gaps.join('; '));
  assert.equal(totals['5.5'].interventions, 4);
  assert.equal(totals['5.5'].perLanding, 4);
  // A caller that never reported keeps both caller metrics partial; it is not a zero.
  request(randomUUID(), at(60), 'terminal-failed');
  totals = (await read()).totals;
  assert.equal(totals['5.2'].partial, true);
  assert.equal(totals['5.3'].partial, true);
  assert(totals['5.2'].gaps.some(gap => gap.startsWith('1 finish submissions')));
  assert.equal(totals['5.5'].partial, false);
  // Before collection began, every metric names its own collection-start gap.
  const early = { from: at(-120), to: at(600) };
  const before = metricsSurface((await readHostedMetricPages(f.query, early)).records, early).totals;
  for (const metric of ['5.2', '5.3', '5.5']) assert.equal(before[metric].partial, true, metric);
  assert.equal(f.meter.writes, 0);
});

test('6000-landing month of receipts pages in bounded calls with zero writes and zero idle calls', async t => {
  const f = fixture();
  assert.equal(f.meter.calls, 0, 'idle costs nothing');
  // 30 days x 200 finishes: one outcome + one delivery each, plus 600 interventions.
  for (let i = 0; i < 6000; i++) {
    const time = at(i * 7.2),
      id = randomUUID();
    for (const [kind, value] of [
      ['outcome', { action: 'finish', operationId: id, errorCodes: [], noOwner: false, noOwnerCause: null }],
      [
        'delivery',
        {
          action: 'finish',
          operationId: id,
          entryId: id,
          state: 'landed',
          noOwner: false,
          noOwnerCause: null,
        },
      ],
    ])
      f.put(
        'projectSelfMetricReceipts',
        {
          projectId: 'project',
          key: `${kind}:${id}`,
          kind,
          actor: 'agent',
          at: time,
          value: JSON.stringify(value),
        },
        time,
      );
    if (i % 10 === 0)
      f.put(
        'projectSelfMetricReceipts',
        {
          projectId: 'project',
          key: `mutation:${id}`,
          kind: 'mutation',
          actor: 'owner',
          at: time,
          value: JSON.stringify({ action: 'prioritize', operationId: id }),
        },
        time,
      );
  }
  const window = { from: at(0), to: at(30 * 1440) };
  const start = performance.now();
  const { records } = await readHostedMetricPages(f.query, window);
  const totals = metricsSurface(records, window).totals;
  const measured = {
    calls: f.meter.calls,
    documents: f.meter.documents,
    writes: f.meter.writes,
    elapsedMs: performance.now() - start,
  };
  t.diagnostic(JSON.stringify(measured));
  assert.equal(totals['5.2'].finishes, 6000);
  assert.equal(totals['5.5'].interventions, 600);
  // 12,600 receipt rows = 126 receipt pages; the seven other streams are empty.
  assert(measured.calls <= 140, `${measured.calls} calls`);
  assert(measured.documents <= 14000, `${measured.documents} documents`);
  assert.equal(measured.writes, 0);
});
