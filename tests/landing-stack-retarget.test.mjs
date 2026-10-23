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
import { enqueueLanding, composeBatch, selectBatch, batchEdit } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';

async function fixture(t, batch) {
  const root = mkdtempSync(join(tmpdir(), 'forge-retarget-'));
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
  const check = await call('define-check', {
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  if (batch) await call('set-policy', { checks: { runner: 'local' } });
  const start = (outcome, parent) =>
    call('start', { outcome, ...(parent ? { stackOn: parent.laneId } : {}) });
  const edit = (lane, path, text) => writeFileSync(join(lane.path, path), text);
  const save = lane => call('checkpoint', { laneId: lane.laneId, message: 'Save' });
  const land = async (lanes, extra = {}) => {
    const result = await call('land', { laneIds: lanes.map(lane => lane.laneId), keepOpen: true, ...extra });
    await drainPostAccept(store);
    return result;
  };
  const main = () =>
    store
      .load()
      .channelMoves.filter(move => move.status === 'accepted')
      .at(-1);
  const content = path => {
    const file = source.state(main().head).files.find(file => file.path === path);
    return file && source.object(file.blob).toString();
  };
  const accepted = result =>
    assert.ok(
      result.entries.every(entry => entry.status === 'accepted'),
      JSON.stringify({
        entries: result.entries,
        runs: store
          .load()
          .runs.map(run => ({ status: run.status, exitCode: run.exitCode, details: run.details })),
      }),
    );
  return { agent, store, source, call, start, edit, save, land, main, content, accepted, check };
}

for (const batch of [false, true]) {
  const mode = batch ? 'batch' : 'single';
  test(`${mode}: landed parent whole-file add/add retargets saved child without editing its Lane`, async t => {
    const f = await fixture(t, batch),
      parent = await f.start('Parent'),
      peer = await f.start('Peer');
    f.edit(parent, 'added.txt', 'parent version\n');
    await f.save(parent);
    const child = await f.start('Child', parent);
    f.edit(child, 'added.txt', 'child replacement\n');
    const saved = await f.save(child);
    f.edit(child, 'added.txt', 'unsaved draft\n');
    f.edit(peer, 'peer.txt', 'accepted peer\n');
    await f.save(peer);
    f.accepted(await f.land([peer]));
    f.accepted(await f.land([parent]));
    assert.notEqual(f.main().head, child.base);
    const request = { operationId: randomUUID() };
    f.accepted(await f.land([child], request));
    assert.equal(f.content('added.txt'), 'child replacement\n');
    assert.equal(f.content('peer.txt'), 'accepted peer\n');
    assert.equal(f.store.select('lanes', child.laneId).head, saved.head);
    assert.equal(readFileSync(join(child.path, 'added.txt'), 'utf8'), 'unsaved draft\n');
    const count = f.store.load().channelMoves.length;
    f.accepted(await f.land([child], request));
    assert.equal(f.store.load().channelMoves.length, count);
    const view = f.store.select('views', f.main().viewId);
    assert.ok(view.inputs.some(pin => pin.laneId === child.laneId && pin.head === saved.head));
    f.edit(child, 'added.txt', 'next child save\n');
    await f.save(child);
    f.accepted(await f.land([child]));
    assert.equal(f.content('added.txt'), 'next child save\n');
  });

  test(`${mode}: parent updates and later main changes survive clean child retarget`, async t => {
    const f = await fixture(t, batch),
      parent = await f.start('Parent');
    f.edit(parent, 'added.txt', 'old parent\n');
    await f.save(parent);
    const child = await f.start('Child', parent);
    f.edit(child, 'child.txt', 'child\n');
    await f.save(child);
    f.edit(parent, 'added.txt', 'new parent\n');
    await f.save(parent);
    f.accepted(await f.land([parent]));
    const peer = await f.start('Later main');
    f.edit(peer, 'later.txt', 'later\n');
    await f.save(peer);
    f.accepted(await f.land([peer]));
    f.accepted(await f.land([child]));
    assert.equal(f.content('added.txt'), 'new parent\n');
    assert.equal(f.content('child.txt'), 'child\n');
    assert.equal(f.content('later.txt'), 'later\n');
  });

  test(`${mode}: three stacked Lanes land in three batches with no manual sync`, async t => {
    const f = await fixture(t, batch),
      a = await f.start('A');
    f.edit(a, 'chain.txt', 'A\n');
    await f.save(a);
    const b = await f.start('B', a);
    f.edit(b, 'chain.txt', 'B\n');
    await f.save(b);
    const c = await f.start('C', b);
    f.edit(c, 'chain.txt', 'C\n');
    await f.save(c);
    for (const lane of [a, b, c]) f.accepted(await f.land([lane]));
    assert.equal(f.content('chain.txt'), 'C\n');
    assert.equal(f.store.load().channelMoves.length, 3);
    if (batch) assert.equal(f.store.load().landingBatches.length, 3);
  });

  test(`${mode}: real overlap names only the accepted Lane that changed the conflict path`, async t => {
    const f = await fixture(t, batch),
      parent = await f.start('Parent');
    f.edit(parent, 'shared.txt', 'parent\n');
    await f.save(parent);
    const child = await f.start('Child', parent);
    f.edit(child, 'shared.txt', 'child\n');
    await f.save(child);
    f.accepted(await f.land([parent]));
    const overlapping = await f.start('Overlap'),
      unrelated = await f.start('Unrelated');
    f.edit(overlapping, 'shared.txt', 'overlapping\n');
    f.edit(unrelated, 'elsewhere.txt', 'unrelated\n');
    await f.save(overlapping);
    await f.save(unrelated);
    f.accepted(await f.land([overlapping, unrelated]));
    const result = await f.land([child]);
    assert.equal(result.entries[0].status, 'conflict');
    const details = result.entries[0].conflict;
    assert.ok(details.includes(overlapping.laneId), details);
    assert.ok(!details.includes(unrelated.laneId), details);
    assert.ok(!details.includes(parent.laneId), details);
    assert.match(details, /shared.txt/);
    assert.equal(f.content('shared.txt'), 'overlapping\n');
  });
}

test('queued saved Candidate retargets in composer and replays the same prefix after a later child sync', async t => {
  const f = await fixture(t, true),
    parent = await f.start('Parent');
  f.edit(parent, 'shared.txt', 'parent\n');
  await f.save(parent);
  const child = await f.start('Child', parent);
  f.edit(child, 'shared.txt', 'child\n');
  const saved = await f.save(child);
  const composed = await f.call('compose', {
    intentId: child.intentId,
    inputs: [{ laneId: child.laneId, head: saved.head }],
    dependencies: [],
  });
  const view = f.store.select('views', composed.viewId);
  const peer = await f.start('Peer');
  f.edit(peer, 'peer.txt', 'peer\n');
  await f.save(peer);
  f.accepted(await f.land([peer]));
  f.accepted(await f.land([parent]));
  await enqueueLanding(
    f.agent.work,
    {
      action: 'finish',
      operationId: randomUUID(),
      laneId: child.laneId,
      expectedHead: saved.head,
      checkId: f.store.load().checks[0].id,
      expectedDefinition: f.store.load().checks[0].definition,
      accept: { channel: 'main', expectedPrevious: f.main().head },
    },
    view,
  );
  await f.call('sync', { laneId: child.laneId });
  const batch = await batchEdit(f.agent.work, randomUUID(), data => selectBatch(f.agent.work, data, 'main'));
  const first = await composeBatch(f.agent.work, batch);
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.prefixes.length, 1);
  const replay = await composeBatch(f.agent.work, batch);
  assert.equal(replay.prefixes[0].head, first.prefixes[0].head);
  await drainLandingBatches(f.agent.work, 'main');
  assert.equal(f.content('shared.txt'), 'child\n');
  assert.equal(f.content('peer.txt'), 'peer\n');
});

test('retargeting keeps the selected main when the parent lands again before composition', async t => {
  const f = await fixture(t, true),
    parent = await f.start('Parent');
  f.edit(parent, 'shared.txt', 'parent\n');
  await f.save(parent);
  const child = await f.start('Child', parent);
  f.edit(child, 'shared.txt', 'child\n');
  const saved = await f.save(child);
  const peer = await f.start('Peer');
  f.edit(peer, 'peer.txt', 'peer\n');
  await f.save(peer);
  f.accepted(await f.land([peer]));
  f.accepted(await f.land([parent]));
  const main = f.main().head;
  const composed = await f.call('compose', {
    intentId: child.intentId,
    inputs: [{ laneId: child.laneId, head: saved.head }],
    dependencies: [],
  });
  const view = f.store.select('views', composed.viewId);
  f.edit(parent, 'later.txt', 'later parent\n');
  await f.save(parent);
  f.accepted(await f.land([parent]));
  const { composeLandingSource } = await import('../dist/landing-compose-source.js');
  const result = composeLandingSource(f.store, f.source, view, main, 'Pinned retarget', view.at);
  assert.deepEqual(result.conflicts, []);
  const files = f.source.state(result.head).files;
  assert.equal(f.source.object(files.find(file => file.path === 'shared.txt').blob).toString(), 'child\n');
  assert.equal(
    files.some(file => file.path === 'later.txt'),
    false,
  );
  assert.ok(f.source.contains(result.head, main));
});
