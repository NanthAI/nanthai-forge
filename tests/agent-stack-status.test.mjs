// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { stackStatus } from '../dist/agent-stack.js';
import { laneReceipt } from '../dist/agent-receipts.js';

const lane = (id, parent, extra = {}) => ({
  id,
  base: 'source',
  head: 'source',
  state: 'active',
  ...(parent ? { stack: { laneId: parent, startHead: 'source', head: 'source', channel: 'main' } } : {}),
  ...extra,
});
function storeFor(...lanes) {
  return {
    native: true,
    root: '/synthetic-unused',
    select(collection, id) {
      assert.equal(collection, 'lanes');
      assert.equal(typeof id, 'string', 'never look up an undefined parent');
      return lanes.find(item => item.id === id);
    },
    page: () => ({ records: [], nextOffset: null }),
    load: () => ({ nativeHead: 'accepted-main' }),
  };
}

test('receipt status retains the Lane identity through a three-level stack', () => {
  const a = lane('ancestor'),
    b = lane('parent', a.id),
    c = lane('child', b.id);
  const store = storeFor(a, b, c);
  const expected = stackStatus(store, c);
  const receipt = laneReceipt(c, '/synthetic-child');
  const status = stackStatus(store, receipt);
  assert.deepEqual(status, expected);
  assert.equal(status.summary, 'ancestor → parent → child · up-to-date');
  assert.equal(status.depth, 3);
  assert.equal(receipt.laneId, c.id);
  assert.equal('id' in receipt, false);
});

test('detached receipts stop at main and do not traverse a missing historical parent', () => {
  const child = lane('child', 'removed');
  child.stack.detached = true;
  const status = stackStatus(storeFor(child), laneReceipt(child, '/synthetic-child'));
  assert.equal(status.status, 'main');
  assert.equal(status.depth, 1);
  assert.equal(status.summary, 'child · main');
  assert.equal(status.target, 'accepted-main');
  assert.equal(status.chainStatus, undefined);
});

test('missing parent records have an explicit status and never imply parent movement', () => {
  const child = lane('child', 'removed');
  const status = stackStatus(storeFor(child), child);
  assert.equal(status.status, 'parent-missing');
  assert.equal(status.chainStatus, 'parent-missing');
  assert.equal(status.parent, 'removed');
  assert.equal(status.parentHead, null);
  assert.equal(status.target, null);
  assert.equal(status.depth, 1);
  assert.equal(status.summary, 'child · parent-missing');
});

for (const parent of [undefined, null, '']) {
  test(`legacy incomplete stack with ${String(parent)} parent reports unknown without a lookup`, () => {
    const child = lane('child', 'parent');
    child.stack.laneId = parent;
    const status = stackStatus(storeFor(child), child);
    assert.equal(status.status, 'parent-unknown');
    assert.equal(status.chainStatus, 'parent-unknown');
    assert.equal(status.parent, null);
    assert.equal(status.depth, 1);
    assert.equal(status.target, null);
    assert.equal(status.summary, 'child · parent-unknown');
  });
}

for (const missingId of [false, true]) {
  test(`broken ancestor (${missingId ? 'unknown id' : 'missing record'}) terminates a multi-level chain explicitly`, () => {
    const parent = lane('parent', 'removed'),
      child = lane('child', parent.id);
    if (missingId) delete parent.stack.laneId;
    const status = stackStatus(storeFor(parent, child), child);
    assert.equal(status.status, 'up-to-date');
    assert.equal(status.chainStatus, missingId ? 'parent-unknown' : 'parent-missing');
    assert.equal(status.depth, 2);
    assert.match(status.summary, /^parent → child · up-to-date · parent-/);
  });
}

test('legacy stack pins without detached retain parent movement and abandoned status', () => {
  const parent = lane('parent'),
    child = lane('child', parent.id);
  parent.head = 'new-source';
  assert.equal(stackStatus(storeFor(parent, child), child).status, 'parent-moved');
  parent.state = 'abandoned';
  assert.equal(stackStatus(storeFor(parent, child), child).status, 'parent-abandoned');
  delete child.stack;
  assert.equal(stackStatus(storeFor(parent, child), child), undefined);
});

test('cyclic parent records stop before repeating an id and disclose incomplete ancestry', () => {
  const a = lane('first', 'second'),
    b = lane('second', 'first');
  const status = stackStatus(storeFor(a, b), a);
  assert.equal(status.depth, 2);
  assert.equal(status.chainStatus, 'cycle');
  assert.equal(status.summary, 'second → first · up-to-date · cycle');
});

test('project and Intent status annotate stacked receipts through records and legacy storage', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-stack-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const call = async command => (await agent.dispatch(command)).result;
  const parent = await call({ action: 'start', outcome: 'Parent' });
  const child = await call({ action: 'start', outcome: 'Child', stackOn: parent.laneId });
  const expected = (await call({ action: 'status', laneId: child.laneId })).lane.stackStatus;
  const check = async () => {
    for (const command of [
      { action: 'status', detail: true },
      { action: 'status', intentId: child.intentId, detail: true },
      { action: 'records', collection: 'lanes' },
      { action: 'records', collection: 'lanes', state: 'active' },
    ]) {
      const result = await call(command);
      const items = result.lanes?.items ?? result.items;
      const receipt = items.find(item => (item.laneId ?? item.id) === child.laneId);
      assert.deepEqual(receipt.stackStatus, expected);
    }
  };
  await check();
  // A portable, pre-records owner exercises the separate legacy status projector.
  const snapshot = agent.work.store.snapshotBytes();
  writeFileSync(join(agent.work.store.directory, 'work.json'), snapshot);
  await check();
});
