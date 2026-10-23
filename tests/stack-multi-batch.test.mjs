// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { stackStatus, stackSyncTarget } from '../dist/agent-stack.js';
import { waitingDependencies } from '../dist/agent-dependencies.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-stack-multi-batch-'));
  writeFileSync(join(root, 'original.txt'), 'original\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store,
    source = new NativeSource(root);
  const previousQueue = process.env.FORGE_CHECK_QUEUE_DIR;
  process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
  t.after(async () => {
    await drainPostAccept(store);
    if (previousQueue === undefined) delete process.env.FORGE_CHECK_QUEUE_DIR;
    else process.env.FORGE_CHECK_QUEUE_DIR = previousQueue;
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (action, body = {}) =>
    (await agent.dispatch({ action, operationId: randomUUID(), ...body })).result;
  await call('define-check', { name: 'verify', executable: process.execPath, args: ['-e', '0'] });
  await call('set-policy', { checks: { runner: 'local' } });
  const start = (outcome, options = {}) => call('start', { outcome, ...options });
  const save = async (lane, path, text) => {
    writeFileSync(join(lane.path, path), text);
    return call('checkpoint', { laneId: lane.laneId, message: 'Save fixture' });
  };
  const land = async (lanes, options = {}) => {
    const result = await call('land', { laneIds: lanes.map(lane => lane.laneId), ...options });
    await drainPostAccept(store);
    return result;
  };
  const accepted = result =>
    assert.ok(
      result.entries.length && result.entries.every(entry => entry.status === 'accepted'),
      JSON.stringify(result.entries),
    );
  const main = () =>
    store
      .load()
      .channelMoves.filter(move => move.status === 'accepted')
      .at(-1);
  const content = path => {
    const file = source.state(main().head).files.find(file => file.path === path);
    return file && source.object(file.blob).toString();
  };
  return { store, call, start, save, land, accepted, main, content };
}

for (const parentFirst of [true, false]) {
  test(`multi-Lane batch recognizes parent ${parentFirst ? 'first' : 'last'} and retargets two stacked descendants`, async t => {
    const f = await fixture(t),
      parent = await f.start('Parent');
    await f.save(parent, 'chain.txt', 'parent\n');
    const child = await f.start('Child', { stackOn: parent.laneId });
    const childSave = await f.save(child, 'chain.txt', 'child\n');
    const grandchild = await f.start('Grandchild', { stackOn: child.laneId });
    const grandchildSave = await f.save(grandchild, 'chain.txt', 'grandchild\n');
    const peer = await f.start('Unrelated');
    await f.save(peer, 'peer.txt', 'peer\n');
    const peer2 = await f.start('Another unrelated');
    await f.save(peer2, 'peer2.txt', 'peer2\n');
    const request = { operationId: randomUUID() };
    assert.deepEqual((await f.land([grandchild], request)).counts, { waiting: 1 });
    assert.equal(waitingDependencies(f.store, [child.laneId]).length, 1);
    f.accepted(await f.land(parentFirst ? [parent, peer] : [peer, parent]));
    assert.equal(f.store.load().channelMoves.length, 1);
    const receipt = f.main(),
      view = f.store.select('views', receipt.viewId);
    assert.equal(view.inputs.length, 2);
    assert.equal(view.intentId, parentFirst ? peer.intentId : parent.intentId);
    const lane = f.store.select('lanes', child.laneId);
    assert.equal(stackStatus(f.store, lane).status, 'parent-landed');
    assert.equal(stackStatus(f.store, lane).acceptanceId, receipt.id);
    assert.equal(stackSyncTarget(f.store, lane).target, receipt.head);
    assert.equal(stackSyncTarget(f.store, lane).stack.after.detached, true);
    assert.equal((await f.call('status', { laneId: child.laneId })).lane.stackStatus.status, 'parent-landed');
    assert.equal((await f.call('peers', { laneId: child.laneId })).stack.status, 'parent-landed');
    assert.deepEqual(waitingDependencies(f.store, [child.laneId]), []);
    assert.equal(stackStatus(f.store, f.store.select('lanes', grandchild.laneId)).status, 'up-to-date');
    writeFileSync(join(child.path, 'chain.txt'), 'unsaved child\n');
    f.accepted(await f.land(parentFirst ? [child, peer2] : [peer2, child]));
    assert.equal(f.store.load().channelMoves.length, 2);
    assert.equal(f.store.select('views', f.main().viewId).inputs.length, 2);
    assert.equal(f.content('chain.txt'), 'child\n');
    assert.equal(f.content('peer.txt'), 'peer\n');
    assert.equal(f.store.select('lanes', child.laneId).head, childSave.head);
    assert.equal(readFileSync(join(child.path, 'chain.txt'), 'utf8'), 'unsaved child\n');
    const grandchildLane = f.store.select('lanes', grandchild.laneId);
    assert.equal(stackStatus(f.store, grandchildLane).status, 'parent-landed');
    assert.deepEqual(waitingDependencies(f.store, [grandchild.laneId]), []);
    f.accepted(await f.land([grandchild], request));
    assert.equal(f.content('chain.txt'), 'grandchild\n');
    assert.equal(f.store.select('lanes', grandchild.laneId).head, grandchildSave.head);
    const count = f.store.load().channelMoves.length;
    f.accepted(await f.land([grandchild], request));
    assert.equal(f.store.load().channelMoves.length, count);
    assert.equal(f.content('peer2.txt'), 'peer2\n');
  });
}

test('Intent dependency finds exact inputs across batch Intents and still waits for unlanded siblings and newer saves', async t => {
  const f = await fixture(t),
    parent = await f.start('Parent');
  await f.save(parent, 'parent.txt', 'parent\n');
  const sibling = await f.start('Sibling', { intentId: parent.intentId });
  const dependent = await f.start('Dependent', { after: { intentId: parent.intentId } });
  await f.save(dependent, 'dependent.txt', 'dependent\n');
  const peer = await f.start('Unrelated');
  await f.save(peer, 'peer.txt', 'peer\n');
  f.accepted(await f.land([parent, peer]));
  assert.notEqual(f.store.select('views', f.main().viewId).intentId, parent.intentId);
  assert.equal(waitingDependencies(f.store, [dependent.laneId]).length, 1);
  f.accepted(await f.land([sibling]));
  assert.deepEqual(waitingDependencies(f.store, [dependent.laneId]), []);
  await f.save(parent, 'parent.txt', 'new save\n');
  assert.equal(waitingDependencies(f.store, [dependent.laneId]).length, 1);
  f.accepted(await f.land([parent, peer]));
  assert.deepEqual(waitingDependencies(f.store, [dependent.laneId]), []);
  f.accepted(await f.land([dependent]));
  assert.equal(f.content('dependent.txt'), 'dependent\n');
});
