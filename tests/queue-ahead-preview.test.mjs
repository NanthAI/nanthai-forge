// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { enqueueLanding, batchEdit } from '../dist/landing-batch-store.js';
import { withLandingController } from '../dist/landing-worker-context.js';
import { nativeQueueAhead } from '../dist/queue-ahead-native.js';
import { queueAheadPreview, QUEUE_AHEAD_LIMIT } from '../dist/queue-ahead-preview.js';
import { queuedOutcome } from '../dist/landing-submission.js';
import { firstAttemptLandRate } from '../dist/first-attempt-land-rate.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-queue-ahead-'));
  writeFileSync(join(root, 'shared.txt'), 'original\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const call = async (action, body = {}) =>
    (await withLandingController(() => agent.dispatch({ action, operationId: randomUUID(), ...body })))
      .result;
  const check = await call('define-check', {
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const start = async (text, path = 'shared.txt', extra = {}) => {
    const lane = await call('start', { outcome: text, ...extra });
    writeFileSync(join(lane.path, path), `${text}\n`);
    const saved = await call('checkpoint', { laneId: lane.laneId, message: text });
    return { ...lane, head: saved.head };
  };
  const enqueue = async lane => {
    const composed = await call('compose', {
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
      dependencies: [],
    });
    const view = store.select('views', composed.viewId);
    return withLandingController(() =>
      enqueueLanding(
        agent.work,
        {
          action: 'finish',
          operationId: randomUUID(),
          laneId: lane.laneId,
          expectedHead: lane.head,
          checkId: check.checkId,
          expectedDefinition: check.definition,
          accept: { channel: 'main', expectedPrevious: null },
        },
        view,
      ),
    );
  };
  const setStatus = async (entry, status) =>
    withLandingController(() =>
      batchEdit(agent.work, entry.id, data => {
        data.landingEntries.find(item => item.id === entry.id).status = status;
      }),
    );
  return { root, agent, store, call, start, enqueue, setStatus };
}

test('saved queue pins predict conflicts, promote checking advice, and retract on terminal events', async t => {
  const f = await fixture(t),
    a = await f.start('A'),
    b = await f.start('B');
  const first = await f.enqueue(a),
    second = await f.enqueue(b);
  const preview = () => nativeQueueAhead(f.store, f.store.select('landingEntries', second.id));
  let value = preview();
  assert.deepEqual(value.conflicts[0].paths, ['shared.txt']);
  assert.equal(value.conflicts[0].confidence, 'fyi');
  assert.equal(value.conflicts[0].next, undefined);
  assert.match(value.conflicts[0].text, /^if entry .* lands, shared.txt conflict$/);
  assert.equal(value.cost.composeCalls, 2);
  // Unsaved/new saves cannot alter this entry's immutable source selection.
  writeFileSync(join(a.path, 'shared.txt'), 'later draft\n');
  await f.setStatus(first, 'checking');
  value = preview();
  assert.equal(value.conflicts[0].confidence, 'actionable');
  assert.equal(value.conflicts[0].next.stackOn, a.laneId);
  assert.match(value.conflicts[0].next.shell, / start .*stackOn/);
  assert.equal(value.cost.composeCalls, 0);
  assert.equal(value.cost.cacheHits, 1);
  assert.deepEqual(queuedOutcome(f.store, second).queueAhead.conflicts, value.conflicts);
  const status = await f.call('status', { laneId: b.laneId });
  assert.equal(status.lane.submissions[0].queueAhead.conflicts[0].confidence, 'actionable');
  for (const terminal of ['failed', 'conflict', 'cancelled', 'interrupted', 'accepted']) {
    await f.setStatus(first, terminal);
    assert.equal(preview(), undefined, terminal);
    await f.setStatus(first, 'checking');
  }
});

test('disjoint queued edits produce no advice', async t => {
  const f = await fixture(t),
    a = await f.start('A'),
    b = await f.start('B', 'elsewhere.txt');
  await f.enqueue(a);
  const second = await f.enqueue(b);
  assert.deepEqual(nativeQueueAhead(f.store, second).conflicts, []);
});

test('stackOn a queued Lane and sync after failure reapplies only child work onto main', async t => {
  const f = await fixture(t),
    parent = await f.start('parent', 'parent.txt');
  const entry = await f.enqueue(parent);
  const child = await f.start('child', 'child.txt', { stackOn: parent.laneId });
  assert.equal(readFileSync(join(child.path, 'parent.txt'), 'utf8'), 'parent\n');
  await f.setStatus(entry, 'failed');
  const status = await f.call('status', { laneId: child.laneId });
  assert.equal(status.lane.stackStatus.status, 'parent-failed');
  await f.call('sync', { laneId: child.laneId });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(child.path, 'parent.txt')), false);
  assert.equal(readFileSync(join(child.path, 'child.txt'), 'utf8'), 'child\n');
  const saved = f.store.select('lanes', child.laneId);
  assert.equal(saved.stack.detached, true);
  assert.equal(saved.after, undefined);
});

test('advisory work is capped and cached without blocking submission', () => {
  const rows = Array.from({ length: QUEUE_AHEAD_LIMIT + 3 }, (_, n) => ({
    id: String(n),
    head: String(n),
    lanes: ['parent'],
    status: 'checking',
  }));
  const values = new Map();
  const cache = { read: key => values.get(key), write: (key, value) => values.set(key, value) };
  let calls = 0;
  const source = {
    compose: () => {
      calls++;
      return { head: 'composed', conflicts: [] };
    },
  };
  let result = queueAheadPreview(source, cache, '/fixture', 'main', 'mine', rows);
  assert.equal(result.considered, QUEUE_AHEAD_LIMIT);
  assert.equal(result.more, true);
  assert.equal(calls, QUEUE_AHEAD_LIMIT * 2);
  result = queueAheadPreview(source, cache, '/fixture', 'main', 'mine', rows);
  assert.equal(result.cost.composeCalls, 0);
  assert.equal(result.cost.cacheHits, QUEUE_AHEAD_LIMIT);
  assert.equal(result.conflicts.length, 0);
  const unavailable = queueAheadPreview(
    {
      compose() {
        throw Error('unavailable');
      },
    },
    cache,
    '/fixture',
    'new-main',
    'mine',
    rows,
  );
  assert.equal(unavailable.unavailable.length, QUEUE_AHEAD_LIMIT);
});

test('first-entry rate counts Lanes, includes pending, retains pre-window context and reports retry causes', () => {
  const at = n => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const row = (id, day, laneIds, accepted = false, cause = 'other', pending = false) => ({
    id,
    at: at(day),
    laneIds,
    accepted,
    cause,
    pending,
  });
  const rows = [
    row('old', 1, ['old']),
    row('old-retry', 12, ['old'], true),
    row('first', 11, ['a', 'b'], true),
    row('conflict', 11, ['c'], false, 'conflict'),
    row('retry', 12, ['c'], true),
    row('check', 11, ['d'], false, 'check-failure-or-flake'),
    row('retry-d', 12, ['d'], true),
    row('stall', 11, ['e'], false, 'stall'),
    row('retry-e', 12, ['e'], true),
    row('cancel', 11, ['f'], false, 'cancelled'),
    row('retry-f', 12, ['f'], true),
    row('pending', 11, ['g'], false, 'other', true),
    row('end', 20, ['outside'], true),
  ];
  const metric = firstAttemptLandRate(rows, at(10), at(20));
  assert.equal(metric.lanes, 7);
  assert.equal(metric.accepted, 2);
  assert.equal(metric.rate, 2 / 7);
  assert.equal(metric.pending, 1);
  assert.equal(metric.retriedLanes, 4);
  assert.deepEqual(metric.retryCauses, {
    conflict: 1,
    'check-failure-or-flake': 1,
    stall: 1,
    cancelled: 1,
    other: 0,
  });
  assert.equal(firstAttemptLandRate([], at(10), at(20)).rate, null);
});

test('existing metric read keeps hosted child attempts inside their original land entry', async () => {
  const { calculateSelfMetrics } = await import('../dist/self-metrics.js');
  const records = {
    moves: [],
    runs: [],
    receipts: [],
    gaps: [],
    submissions: [
      {
        id: 'attempt-0',
        entryId: 'entry',
        entryAt: '2026-10-11T00:00:00.000Z',
        entryStatus: 'landed',
        at: '2026-10-11T00:00:00.000Z',
        inputs: [{ laneId: 'lane', intentId: 'intent', head: 'head' }],
        status: 'superseded',
        progressAt: [],
        runIds: [],
      },
      {
        id: 'attempt-1',
        entryId: 'entry',
        entryAt: '2026-10-11T00:00:00.000Z',
        entryStatus: 'landed',
        at: '2026-10-12T00:00:00.000Z',
        inputs: [{ laneId: 'lane', intentId: 'intent', head: 'head' }],
        status: 'landed',
        progressAt: [],
        runIds: [],
      },
    ],
  };
  const result = calculateSelfMetrics(records, {
    from: '2026-10-10T00:00:00.000Z',
    to: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(result.firstAttemptLandRate.rate, 1);
  assert.equal(result.firstAttemptLandRate.lanes, 1);
  assert.equal(result.firstAttemptLandRate.retriedLanes, 0);
});

test('bound failed-parent sync never falls back to local source after hosted access is revoked', async t => {
  const { queueAheadStackSync } = await import('../dist/queue-ahead-stack-sync.js');
  const { updateHostState } = await import('../dist/host-binding.js');
  const { ForgeError } = await import('../dist/errors.js');
  const f = await fixture(t),
    parent = await f.start('parent', 'parent.txt');
  const child = await f.start('child', 'child.txt', { stackOn: parent.laneId, stackEntry: randomUUID() });
  updateHostState(f.store, state => {
    state.binding = {
      projectId: 'fixture',
      deployment: 'https://fixture.invalid',
      projectUrl: 'https://fixture.invalid/project',
      operationId: randomUUID(),
      name: 'Fixture',
      visibility: 'private',
      backupId: 'fixture',
      autoSync: false,
      sourceAuthority: { mode: 'server', epoch: 1 },
    };
  });
  await assert.rejects(
    queueAheadStackSync(
      f.store,
      { operationId: randomUUID(), laneId: child.laneId, expectedHead: child.head, channel: 'main' },
      () => assert.fail('No native fallback'),
      {
        query: async () => {
          throw new ForgeError('PROJECT_UNAVAILABLE', 'Synthetic revoked access');
        },
      },
    ),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(f.store.select('lanes', child.laneId).head, child.head);
  assert.equal(readFileSync(join(child.path, 'child.txt'), 'utf8'), 'child\n');
});
