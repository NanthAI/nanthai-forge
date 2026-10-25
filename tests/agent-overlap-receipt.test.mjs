// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { overlapReceipt } from '../dist/agent-overlap-receipt.js';
import { initNative } from '../dist/native-work.js';
import { PEERS_MAX_BYTES } from '../dist/agent-peers-bound.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-overlap-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'shared.txt'), 'original\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Receipt fixture' })).result;
  const store = agent.work.store;
  const journal = new CoordinationJournal(store);
  const notice = (index = 0, peer = randomUUID()) => ({
    noticeId: index.toString(16).padStart(64, '0'),
    kind: 'overlap-notice',
    at: '2026-10-25T00:00:00.000Z',
    lanes: [lane.laneId, peer],
    heads: [lane.head, lane.head],
    file: 'shared.txt',
    regions: [[], []],
    proposedOrder: [peer, lane.laneId],
    text: 'Synthetic overlap',
  });
  return { root, agent, lane, store, journal, notice };
}

test('Lane status shows pending overlap repeatedly without writing or consuming it', async t => {
  const f = await fixture(t);
  const notice = f.notice();
  f.journal.recordOverlaps([notice, notice]);
  const directory = join(f.store.directory, 'coordination');
  const snapshot = () =>
    readdirSync(directory, { withFileTypes: true })
      .map(entry => [entry.name, entry.isFile() ? readFileSync(join(directory, entry.name), 'utf8') : null])
      .sort(([a], [b]) => a.localeCompare(b));
  const before = snapshot();
  const revision = f.store.revision();
  for (let i = 0; i < 2; i++) {
    const result = (await f.agent.dispatch({ action: 'status', laneId: f.lane.laneId })).result;
    assert.deepEqual(
      result.peers.inbox.map(item => item.noticeId),
      [notice.noticeId],
    );
    assert.deepEqual(snapshot(), before);
    assert.equal(f.store.revision(), revision);
  }
  const result = (await f.agent.dispatch({ action: 'handoff', laneId: f.lane.laneId, summary: 'Done' }))
    .result;
  assert.deepEqual(
    result.peers.inbox.map(item => item.noticeId),
    [notice.noticeId],
  );
  assert.equal(
    (await f.agent.dispatch({ action: 'status', laneId: f.lane.laneId })).result.peers.inbox,
    undefined,
  );
  assert.equal(f.journal.overlaps().length, 1);
});

test('compact receipt marks only displayed notices and leaves bilateral peer delivery independent', async t => {
  const f = await fixture(t);
  const notices = Array.from({ length: 12 }, (_, index) => f.notice(index));
  f.journal.recordOverlaps(notices);
  const first = overlapReceipt(f.store, f.lane.laneId);
  assert.equal(first.inbox.length, 10);
  assert.equal(first.more, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= PEERS_MAX_BYTES);
  assert.equal(f.journal.pendingOverlaps(f.lane.laneId).length, 2);
  const second = overlapReceipt(f.store, f.lane.laneId);
  assert.equal(second.inbox.length, 2);
  assert.ok(second.inbox.every(item => !first.inbox.some(prior => prior.noticeId === item.noticeId)));
  assert.equal(overlapReceipt(f.store, f.lane.laneId), undefined);
  assert.equal(f.journal.pendingOverlaps(notices[0].lanes[1]).length, 1);
  assert.equal(f.journal.overlaps(f.lane.laneId).length, 12);
});

test('delivery bookkeeping failure still returns the pending digest without consuming it', async t => {
  const f = await fixture(t);
  const notice = f.notice();
  f.journal.recordOverlaps([notice]);
  const marking = t.mock.method(CoordinationJournal.prototype, 'deliverOverlaps', () => {
    throw new Error('Synthetic journal lock contention');
  });
  const result = overlapReceipt(f.store, f.lane.laneId);
  assert.equal(result.coverage, 'local-incomplete');
  assert.deepEqual(
    result.inbox.map(item => item.noticeId),
    [notice.noticeId],
  );
  assert.equal(f.journal.pendingOverlaps(f.lane.laneId).length, 1);
  marking.mock.restore();
  assert.deepEqual(
    overlapReceipt(f.store, f.lane.laneId).inbox.map(item => item.noticeId),
    [notice.noticeId],
  );
  assert.equal(f.journal.pendingOverlaps(f.lane.laneId).length, 0);
});

for (const action of ['complete', 'abandon'])
  test(`${action} delivers pending alerts before ending the Lane turn`, async t => {
    const f = await fixture(t);
    const notice = f.notice();
    f.journal.recordOverlaps([notice]);
    const result = (
      await f.agent.dispatch({
        action,
        laneId: f.lane.laneId,
        ...(action === 'abandon' ? { reason: 'Synthetic close' } : {}),
      })
    ).result;
    assert.deepEqual(
      result.peers.inbox.map(item => item.noticeId),
      [notice.noticeId],
    );
    assert.equal(f.journal.pendingOverlaps(f.lane.laneId).length, 0);
  });

for (const wait of [true, false])
  test(`finish wait:${wait} includes pending alerts without repeating them on handoff`, async t => {
    const f = await fixture(t);
    await f.agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', '0'],
    });
    await f.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'local' } });
    const notice = f.notice();
    f.journal.recordOverlaps([notice]);
    const request = {
      action: 'finish',
      operationId: randomUUID(),
      laneId: f.lane.laneId,
      message: 'Synthetic finish',
      wait,
    };
    const result = (await f.agent.dispatch(request)).result;
    assert.deepEqual(
      result.peers.inbox.map(item => item.noticeId),
      [notice.noticeId],
    );
    assert.equal(f.journal.pendingOverlaps(f.lane.laneId).length, 0);
    const later = f.notice(1);
    f.journal.recordOverlaps([later]);
    const replay = (await new AgentWorkflow(f.root).dispatch({ ...request, ...result.resolved })).result;
    if (wait) {
      const { resolved: _resolved, ...original } = result;
      assert.deepEqual(replay, original);
    } else assert.deepEqual(replay.peers, result.peers);
    assert.deepEqual(
      f.journal.pendingOverlaps(f.lane.laneId).map(item => item.noticeId),
      [later.noticeId],
    );
    overlapReceipt(f.store, f.lane.laneId);
    const next = (await f.agent.dispatch({ action: 'handoff', laneId: f.lane.laneId, summary: 'Done' }))
      .result;
    assert.equal(next.peers?.inbox, undefined);
  });

for (const initiallyPending of [true, false])
  test(`handoff replay retains its ${initiallyPending ? 'delivered' : 'empty'} digest and leaves newer notices pending`, async t => {
    const f = await fixture(t);
    const request = { action: 'handoff', operationId: randomUUID(), laneId: f.lane.laneId, summary: 'Done' };
    if (initiallyPending) f.journal.recordOverlaps([f.notice()]);
    const first = (await f.agent.dispatch(request)).result;
    const later = f.notice(1);
    f.journal.recordOverlaps([later]);
    const restarted = new AgentWorkflow(f.root);
    assert.deepEqual((await restarted.dispatch(request)).result, first);
    assert.deepEqual(
      f.journal.pendingOverlaps(f.lane.laneId).map(item => item.noticeId),
      [later.noticeId],
    );
    const next = (await restarted.dispatch({ ...request, operationId: randomUUID() })).result;
    assert.deepEqual(
      next.peers.inbox.map(item => item.noticeId),
      [later.noticeId],
    );
  });

test('operation digest replay retains compact omissions without consuming them', async t => {
  const f = await fixture(t);
  f.journal.recordOverlaps(Array.from({ length: 12 }, (_, index) => f.notice(index)));
  const operationId = randomUUID();
  const first = overlapReceipt(f.store, f.lane.laneId, undefined, false, false, operationId);
  assert.equal(first.inbox.length, 10);
  const replay = overlapReceipt(f.store, f.lane.laneId, undefined, false, false, operationId);
  assert.deepEqual(replay, first);
  assert.equal(f.journal.pendingOverlaps(f.lane.laneId).length, 2);
  const next = overlapReceipt(f.store, f.lane.laneId, undefined, false, false, randomUUID());
  assert.equal(next.inbox.length, 2);
  assert.ok(next.inbox.every(item => !first.inbox.some(prior => prior.noticeId === item.noticeId)));
});
