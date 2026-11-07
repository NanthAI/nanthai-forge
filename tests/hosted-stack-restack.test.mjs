// SPDX-License-Identifier: Apache-2.0
// Issue f61e9339: a stacked Lane restacks onto its parent's newer saved work automatically when that
// applies cleanly; a conflict changes nothing and is not retried for the same parent head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { restackAfterSave, restackOperationId } from '../dist/hosted-stack-restack.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const stackNotice = await import(moduleUrl('../convex/projectHostedStackNotice.ts'));

const filesOf = (s, head) =>
  Object.fromEntries(
    JSON.parse(s.objects.get(head)).files.map(file => [file.path, s.objects.get(file.blob).toString()]),
  );
const hintOf = async (s, laneId) =>
  JSON.parse(await s.call('overlapRead', overlaps.read, { projectId: s.projectId, laneId })).stack;

/** A parent Lane with p.txt and a child stacked on its saved head that adds c.txt. */
async function stacked() {
  const s = await syncFixture();
  const p0 = s.file('p.txt', 'p0\n');
  const parentPin = s.state([s.baseFile, s.hidden, p0], [s.baseline.sha256]);
  const parent = await s.lane(parentPin);
  const childPin = s.state([s.baseFile, s.hidden, p0, s.file('c.txt', 'c0\n')], [parentPin.sha256]);
  const child = await s.lane(childPin, { stack: { laneId: parent.laneId, head: parent.head } });
  const restack = async (cleanOnly = true) => {
    const entry = (await s.readLane(child.laneId)).entry;
    return s.execute(
      s.request('sync', {
        laneId: child.laneId,
        expected: s.pins(entry),
        target: { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id },
        ...(cleanOnly ? { cleanOnly: true } : {}),
      }),
    );
  };
  const parentSave = async files =>
    s.save((await s.readLane(parent.laneId)).entry, [s.baseFile, s.hidden, ...files]);
  return { s, parent, child, restack, parentSave };
}

test('a parent save makes the child ready; a clean restack moves its head onto the parent with no conflict files', async () => {
  const { s, parent, child, restack, parentSave } = await stacked();
  assert.equal(await hintOf(s, child.laneId), undefined, 'nothing to restack before the parent moves');
  const p1 = await parentSave([s.file('p.txt', 'p1\n')]);
  assert.deepEqual(await hintOf(s, child.laneId), {
    laneId: child.laneId,
    parentLaneId: parent.laneId,
    parentHead: p1.head,
    restack: 'ready',
  });
  assert.equal(await hintOf(s, parent.laneId), undefined, 'an unstacked Lane gets no stack field');

  const result = (await restack()).terminal.outcome.result;
  assert.equal(result.status, 'merged');
  assert.equal(result.lane.laneId, child.laneId, 'the same Lane moves; no resolution sibling');
  const after = (await s.readLane(child.laneId)).record;
  assert.notEqual(after.head, child.head, 'the child head moved');
  assert.equal(after.stack.head, p1.head, 'the stack pin follows the parent');
  assert.deepEqual(filesOf(s, after.head)['p.txt'], 'p1\n', "the parent's new work is in");
  assert.deepEqual(filesOf(s, after.head)['c.txt'], 'c0\n', "the child's own work stays");
  assert.equal(await hintOf(s, child.laneId), undefined, 'restacked: nothing left to do');

  // The next parent save arms it again, once.
  const p2 = await parentSave([s.file('p.txt', 'p2\n')]);
  assert.equal((await hintOf(s, child.laneId)).parentHead, p2.head);
});

test('a conflicting automatic restack changes nothing, makes no resolution Lane and is not retried for that head', async () => {
  const { s, child, restack, parentSave } = await stacked();
  const before = (await s.readLane(child.laneId)).record;
  const lanesBefore = [...s.tables.projectHostedRecordHeads.values()].filter(
    row => row.kind === 'lane',
  ).length;
  const p1 = await parentSave([s.file('p.txt', 'p0\n'), s.file('c.txt', 'parent\n')]);
  assert.equal((await hintOf(s, child.laneId)).restack, 'ready');

  const result = (await restack()).terminal.outcome.result;
  assert.equal(result.status, 'conflict');
  assert.equal(result.lane.laneId, child.laneId, 'no resolution sibling Lane');
  assert.equal(result.resolution, null);
  const after = (await s.readLane(child.laneId)).record;
  assert.equal(after.head, before.head, 'head unchanged');
  assert.deepEqual(after.stack, before.stack, 'stack pin unchanged');
  assert.equal(
    [...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'lane').length,
    lanesBefore,
    'no Lane record was written for the conflict',
  );
  assert.deepEqual(await hintOf(s, child.laneId), {
    laneId: child.laneId,
    parentLaneId: before.stack.laneId,
    parentHead: p1.head,
    restack: 'conflict',
  });

  // A newer parent save re-arms the automatic restack for its new head.
  const p2 = await parentSave([s.file('p.txt', 'p2\n'), s.file('c.txt', 'parent\n')]);
  assert.deepEqual((await hintOf(s, child.laneId)).restack, 'ready');
  assert.equal((await hintOf(s, child.laneId)).parentHead, p2.head);
  // An explicit sync still offers the ordinary resolution flow.
  const manual = (await restack(false)).terminal.outcome.result;
  assert.equal(manual.status, 'conflict');
  assert.notEqual(manual.lane.laneId, child.laneId, 'explicit sync keeps its resolution sibling');
});

test('cleanOnly refuses a Lane that is not stacked', async () => {
  const s = await syncFixture();
  const lane = await s.lane(s.state([s.baseFile, s.hidden, s.file('x', 'x')], [s.baseline.sha256]));
  await assert.rejects(
    s.prepareSync(
      s.request('sync', {
        laneId: lane.laneId,
        expected: s.pins(lane),
        target: { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id },
        cleanOnly: true,
      }),
    ),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
});

test('the hint reads nothing for an unstacked or detached Lane and stays quiet after an abandon or a conflict', async () => {
  const throwing = { db: { query: () => assert.fail('no read without an attached stack') } };
  const project = 'project';
  assert.equal(await stackNotice.stackRestackHint(throwing, project, { id: 'l', state: 'active' }), null);
  assert.equal(
    await stackNotice.stackRestackHint(throwing, project, {
      id: 'l',
      state: 'active',
      stack: { laneId: 'p', head: 'h0', detached: true },
    }),
    null,
  );
  const reads = [];
  const ctx = row => ({
    db: {
      query: table => {
        reads.push(table);
        return { withIndex: () => ({ unique: async () => row }) };
      },
    },
  });
  const lane = { id: 'l', state: 'active', stack: { laneId: 'p', head: 'h0' } };
  const row = { parentLaneId: 'p', laneId: 'l', parentHead: 'h0', latestHead: 'h1' };
  assert.equal((await stackNotice.stackRestackHint(ctx(row), project, lane)).restack, 'ready');
  assert.deepEqual(reads, ['projectHostedStackDependents'], 'one point read');
  assert.equal(await stackNotice.stackRestackHint(ctx({ ...row, ended: 'abandoned' }), project, lane), null);
  assert.equal(
    (await stackNotice.stackRestackHint(ctx({ ...row, restackConflict: 'h1' }), project, lane)).restack,
    'conflict',
  );
  assert.equal(
    await stackNotice.stackRestackHint(ctx({ ...row, latestHead: undefined }), project, lane),
    null,
  );
});

const LANE = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const savedResponse = (restack = 'ready', status = 'completed') => ({
  action: 'save',
  result: { outcome: { status, result: { head: 'a'.repeat(64) } } },
  stack: { laneId: LANE, parentLaneId: PARENT, parentHead: 'b'.repeat(64), restack },
});
const syncResult = (status, laneId = LANE) => ({
  source: {
    outcome: { status: 'completed', result: { status, lane: { laneId, head: 'c'.repeat(64) } } },
  },
  applied: { status: 'applied' },
});

test('save runs one cleanOnly sync with a stable operation id and reports what it did', async () => {
  const calls = [];
  const dispatch = async (action, input) => {
    calls.push({ action, input });
    return { result: syncResult('merged') };
  };
  const response = await restackAfterSave(savedResponse(), LANE, dispatch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'sync');
  assert.equal(calls[0].input.cleanOnly, true);
  assert.equal(calls[0].input.laneId, LANE);
  assert.equal(calls[0].input.operationId, restackOperationId(LANE, 'a'.repeat(64), 'b'.repeat(64)));
  assert.equal(response.stack, undefined, 'the hint is replaced by the outcome');
  assert.equal(response.restack.status, 'restacked');
  assert.equal(response.restack.head, 'c'.repeat(64));
  assert.equal(response.restack.from, 'a'.repeat(64));
  assert.match(response.restack.undo, /lane-history/);
  // A retried save of the same head replays the same restack operation.
  await restackAfterSave(savedResponse(), LANE, dispatch);
  assert.equal(calls[1].input.operationId, calls[0].input.operationId);
});

// Live replay (sweep B, 2026-11-07): `nforge agent . save` dispatches the wire name `checkpoint`, and a
// gate on the raw action name never restacked. The transport keys on the normalized response action.
for (const wire of ['save', 'checkpoint'])
  test(`the transport restacks after a save sent as ${wire}`, async () => {
    const transport = Object.create(HostedAgentTransport.prototype);
    transport.operationContext = new AsyncLocalStorage();
    transport.checkoutLaneId = () => LANE;
    const calls = [];
    transport.dispatchScoped = async action => {
      calls.push(action);
      return action === 'sync' ? { action: 'sync', result: syncResult('merged') } : savedResponse();
    };
    const response = await transport.dispatch(wire, { message: 'm' });
    assert.deepEqual(calls, [wire, 'sync']);
    assert.equal(response.restack.status, 'restacked');
    assert.equal(response.stack, undefined);
  });

test('save does nothing extra unless the hint is ready, the save completed and this checkout is the Lane', async () => {
  let called = 0;
  const dispatch = async () => {
    called++;
    return { result: syncResult('merged') };
  };
  for (const response of [
    savedResponse('conflict'),
    savedResponse('ready', 'submitted'),
    { action: 'save', result: savedResponse().result },
  ])
    assert.deepEqual(await restackAfterSave(response, LANE, dispatch), response);
  const other = savedResponse();
  assert.deepEqual(await restackAfterSave(other, PARENT, dispatch), other, 'another checkout: no restack');
  assert.equal(called, 0);
});

test('a conflict or a failure keeps the save and names the manual sync', async () => {
  const conflict = await restackAfterSave(savedResponse(), LANE, async () => ({
    result: syncResult('conflict'),
  }));
  assert.equal(conflict.restack.status, 'conflict');
  assert.match(conflict.restack.next, /nforge agent \. sync/);
  assert.equal(conflict.result.outcome.status, 'completed', 'the save receipt is kept');
  const failed = await restackAfterSave(savedResponse(), LANE, async () => {
    throw Object.assign(new Error('boom'), { code: 'WORK_STALE' });
  });
  assert.equal(failed.restack.status, 'failed');
  assert.equal(failed.restack.code, 'WORK_STALE');
  assert.match(failed.restack.next, /Your save is kept/);
  const pending = await restackAfterSave(savedResponse(), LANE, async () => ({
    result: { outcome: { status: 'submitted' } },
  }));
  assert.equal(pending.restack.status, 'in-progress');
  assert.match(pending.restack.next, /wait/);
});
