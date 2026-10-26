// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatedFixture, until } from './landing-worker-fixture.mjs';
import { fixture } from './landing-batch-fixture.mjs';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { withLandingController } from '../dist/landing-worker-context.js';
import { readLandingHandle } from '../dist/land-receipt.js';
import { indexedReceiptPeers } from '../dist/agent-receipt-peers.js';

async function saved(f, path = 'desired.txt') {
  const lane = (
    await f.agent.dispatch({ action: 'start', outcome: 'Desired landing', scope: { paths: [path] } })
  ).result;
  writeFileSync(join(lane.path, path), 'saved desired bytes\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save desired state' });
  return lane;
}
const rootModule = name => new URL(`../dist/${name}.js`, import.meta.url).href;
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}
for (const boundary of ['submitted', 'composing', 'checking', 'accepting']) {
  test(`killing the requesting CLI at ${boundary} leaves one independently settled landing`, async t => {
    const f = await gatedFixture(t),
      lane = await saved(f),
      operationId = randomUUID();
    const command = { action: 'land', operationId, laneIds: [lane.laneId] };
    const requester = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { AgentWorkflow } from ${JSON.stringify(rootModule('agent-workflow'))};
const agent = new AgentWorkflow(process.argv[1]), command = JSON.parse(process.argv[2]);
const admitted = await agent.dispatch(command); process.send(admitted.result.handle);
await agent.dispatch({...command,wait:true});`,
        f.root,
        JSON.stringify(command),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let errors = '';
    requester.stderr.on('data', bytes => {
      errors += bytes;
    });
    const [handle] = await once(requester, 'message');
    assert.equal(handle.operationId, operationId);
    assert.equal(f.store.load().runs.length, 0, 'submission starts no check');
    let worker;
    t.after(async () => {
      f.release();
      await stop(requester);
      if (worker) {
        if (worker.connected) worker.send('continue');
        await stop(worker);
      }
    });
    const killRequester = async () => {
      const exited = once(requester, 'exit');
      requester.kill('SIGKILL');
      await exited;
    };
    if (boundary === 'submitted') await killRequester();
    const gate = boundary === 'composing' ? 'compose' : boundary === 'accepting' ? 'accept-channel' : '';
    worker = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { WorkStore } from ${JSON.stringify(rootModule('work-store'))};
import { WorkService } from ${JSON.stringify(rootModule('work'))};
import { watchLandingWorker } from ${JSON.stringify(rootModule('landing-worker'))};
const controller = new AbortController(); process.on('SIGTERM',()=>controller.abort());
const dispatch = WorkService.prototype.dispatch; let gated=false;
WorkService.prototype.dispatch = async function(input,...rest) {
  if (input.action===${JSON.stringify(gate)}&&!gated) { gated=true;process.send('boundary');await new Promise(resolve=>{process.once('message',resolve);controller.signal.addEventListener('abort',resolve,{once:true});if(controller.signal.aborted)resolve();}); }
  return dispatch.call(this,input,...rest);
};
await watchLandingWorker(new WorkStore(process.argv[1]),controller.signal);`,
        f.root,
      ],
      { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let workerErrors = '';
    worker.stderr.on('data', bytes => {
      workerErrors += bytes;
    });
    if (boundary === 'composing' || boundary === 'accepting') {
      if (boundary === 'accepting') f.release();
      await once(worker, 'message');
      assert.equal(f.store.load().channelMoves.length, 0, 'requester dies before publication');
      await killRequester();
      worker.send('continue');
      if (boundary === 'composing') f.release();
    } else if (boundary === 'checking') {
      await until(f, () => f.started, 'check started');
      await killRequester();
      f.release();
    } else f.release();
    await until(f, () => readLandingHandle(f.store, operationId).result.complete, 'desired landing settled');
    await stop(worker);
    assert.doesNotMatch(workerErrors, /Unhandled|Error:/);
    const outcome = (await f.agent.dispatch({ action: 'landing', operationId })).result;
    assert.deepEqual(outcome.handle, handle);
    assert.equal(outcome.phase, 'landed');
    assert.equal(f.store.load().channelMoves.length, 1);
    assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
    const before = f.store.revision();
    const lock = f.store.locked;
    f.store.locked = () => assert.fail('landing observation must not join the writer queue');
    try {
      assert.equal(readLandingHandle(f.store, operationId).result.complete, true);
    } finally {
      f.store.locked = lock;
    }
    assert.equal(f.store.revision(), before);
    const attempt = outcome.entries[0].phases.attempts[0];
    assert.ok(attempt.composeStartedAt && attempt.composedAt && attempt.settledAt);
    assert.ok(attempt.writerLocks.length > 0);
    assert.ok(attempt.writerLocks.every(span => span.waitMs >= 0 && span.holdMs >= 0));
    t.diagnostic(JSON.stringify({ boundary, droppedLandings: 0, operatorMutationsToSettle: 0, checks: 1 }));
  });
}

test('fresh operation ids reuse the pending and terminal handle, including a mixed selection', async t => {
  const f = await fixture(t, { remote: false }),
    a = await saved(f, 'a.txt'),
    b = await saved(f, 'b.txt');
  const first = (await f.agent.dispatch({ action: 'land', operationId: randomUUID(), laneIds: [a.laneId] }))
    .result;
  const aliasId = randomUUID();
  const alias = (await f.agent.dispatch({ action: 'land', operationId: aliasId, laneIds: [a.laneId] }))
    .result;
  assert.deepEqual(alias.handle, first.handle);
  const mixed = (
    await f.agent.dispatch({ action: 'land', operationId: randomUUID(), laneIds: [a.laneId, b.laneId] })
  ).result;
  assert.equal(mixed.handle.entryIds[0], first.handle.entryIds[0]);
  // This case checks alias/group identity. Drive the two retained controller
  // requests explicitly instead of imposing one 20-second wall bound on two
  // independent OS check processes. The killed-requester cases above exercise
  // the real owner watcher without a requesting controller.
  await withLandingController(async () => {
    await f.agent.dispatch({ action: 'land', operationId: first.operationId, laneIds: [a.laneId] });
    await f.agent.dispatch({
      action: 'land',
      operationId: mixed.operationId,
      laneIds: [a.laneId, b.laneId],
    });
  });
  assert.equal((await f.agent.dispatch({ action: 'landing', operationId: aliasId })).result.complete, true);
  assert.equal(f.store.load().landingEntries.length, 2);
  const replay = (await f.agent.dispatch({ action: 'land', operationId: randomUUID(), laneIds: [a.laneId] }))
    .result;
  assert.deepEqual(replay.handle, first.handle);
  assert.equal(replay.complete, true);
});

test('peer advice uses the current saved head and a shared landing handle without owner locks', async t => {
  const f = await fixture(t, { remote: false }),
    peer = await saved(f, 'shared.txt'),
    mine = await saved(f, 'shared.txt');
  const checked = (
    await f.agent.dispatch({ action: 'finish', laneId: peer.laneId, message: 'Check the saved peer' })
  ).result;
  assert.equal(checked.complete, true);
  assert.equal(
    indexedReceiptPeers(f.store, { laneId: mine.laneId }).overlaps.find(item => item.lane === peer.laneId)
      .landing.phase,
    'checked-green',
  );
  const submitted = (
    await f.agent.dispatch({
      action: 'land',
      operationId: randomUUID(),
      laneIds: [peer.laneId],
      keepOpen: true,
    })
  ).result;
  const peers = indexedReceiptPeers(f.store, { laneId: mine.laneId });
  const item = peers.overlaps.find(item => item.lane === peer.laneId);
  assert.equal(item.landing.phase, 'queued');
  assert.deepEqual(item.landing.handle.entryIds, submitted.handle.entryIds);
  assert.match(item.landing.suggestedAction, /green run.*saved interface/);
  assert.equal(item.landing.latestCheck.status, 'passed');
  writeFileSync(join(peer.path, 'shared.txt'), 'a newer save\n');
  const next = (
    await f.agent.dispatch({ action: 'checkpoint', laneId: peer.laneId, message: 'New desired head' })
  ).result;
  const old = (await f.agent.dispatch({ action: 'landing', operationId: submitted.operationId })).result
    .entries[0].submissions[0];
  assert.equal(old.state, 'superseded');
  assert.equal(old.supersededBy, next.head);
  const current = indexedReceiptPeers(f.store, { laneId: mine.laneId }).overlaps.find(
    item => item.lane === peer.laneId,
  );
  assert.equal(current.landing.phase, 'editing');
  assert.equal(current.landing.latestCheck, null);
});

test('land reuses an existing finish queue entry and wait settings do not change the goal', async t => {
  const f = await fixture(t, { remote: false });
  const existing = await f.candidate('finish-entry.txt');
  const operationId = randomUUID();
  const submitted = (
    await f.agent.dispatch({ action: 'land', operationId, laneIds: [existing.lane.laneId], waitMs: 0 })
  ).result;
  assert.equal(submitted.handle.operationId, existing.command.operationId);
  assert.deepEqual(submitted.handle.entryIds, [existing.command.operationId]);
  const replay = (
    await f.agent.dispatch({ action: 'land', operationId, laneIds: [existing.lane.laneId], waitMs: 10 })
  ).result;
  assert.deepEqual(replay.handle, submitted.handle);
  const controller = new AbortController(),
    worker = watchLandingWorker(f.store, controller.signal);
  try {
    await until(
      f,
      () => readLandingHandle(f.store, operationId).result.complete,
      'shared finish entry settled',
    );
  } finally {
    controller.abort();
    await worker;
  }
  assert.equal(f.store.load().landingEntries.length, 1);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
});

test('a failed desired check delivers a terminal reason after requester death', async t => {
  const f = await fixture(t, { remote: false, failWhen: 'true' }),
    lane = await saved(f),
    operationId = randomUUID();
  const command = { action: 'land', operationId, laneIds: [lane.laneId] };
  const requester = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { AgentWorkflow } from ${JSON.stringify(rootModule('agent-workflow'))};
const agent = new AgentWorkflow(process.argv[1]), command = JSON.parse(process.argv[2]);
const admitted = await agent.dispatch(command); process.send(admitted.result.handle);
await agent.dispatch({...command,wait:true});`,
      f.root,
      JSON.stringify(command),
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  t.after(() => stop(requester));
  const [handle] = await once(requester, 'message');
  const exited = once(requester, 'exit');
  requester.kill('SIGKILL');
  await exited;
  const controller = new AbortController(),
    worker = watchLandingWorker(f.store, controller.signal);
  try {
    await until(f, () => readLandingHandle(f.store, operationId).result.terminal, 'failed goal settled');
  } finally {
    controller.abort();
    await worker;
  }
  const outcome = (await f.agent.dispatch({ action: 'landing', operationId })).result;
  assert.deepEqual(outcome.handle, handle);
  assert.equal(outcome.phase, 'terminal-failed');
  assert.equal(outcome.entries[0].submissions[0].cause, 'check-failed');
  assert.equal(f.store.load().channelMoves.length, 0);
});
