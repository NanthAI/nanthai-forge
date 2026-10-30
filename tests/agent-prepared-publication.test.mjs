// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { agentCheckpoint } from '../dist/agent-workflow-mutations.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { nativeObjects } from '../dist/native-objects.js';
import { WorkStore } from '../dist/work-store.js';
import { ForgeError } from '../dist/errors.js';
import { trustAgents } from './autonomy-fixture.mjs';

const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
async function fixture(t, native = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-prepared-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  if (native) initNative(root);
  else {
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Fixture');
  }
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
    declaredInputs: [{ kind: 'source', path: 'a.txt' }],
  });
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic publication' })).result;
  return { root, agent, store, lane, peer: new WorkStore(root) };
}

test('run registration observes declared source bytes and stages pages without the owner lock', async t => {
  const { agent, store, lane } = await fixture(t);
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const object = NativeSource.prototype.object;
  let reads = 0;
  t.mock.method(NativeSource.prototype, 'object', function (...args) {
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    reads++;
    return object.apply(this, args);
  });
  const result = await agent.dispatch({ action: 'run', viewId: view.viewId, wait: true });
  assert.equal(result.result.status, 'passed');
  const run = store.select('runs', result.result.operationId);
  assert.equal(run.inputObservations[0].status, 'observed');
  assert.ok(reads > 0);
});

test('legacy run registration migrates once without requiring a new user retry', async t => {
  const { agent, store, lane } = await fixture(t);
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const data = store.load();
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(data));
  assert.equal(store.readRecords(), undefined);
  const result = await agent.dispatch({ action: 'run', viewId: view.viewId, wait: true });
  assert.equal(result.result.status, 'passed');
  assert.ok(store.readRecords());
  assert.equal(store.load().runs.length, 1);
});

test('a run preparation CAS race never publishes stale evidence or starts a duplicate command', async t => {
  const { agent, store, peer, lane } = await fixture(t);
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const operationId = randomUUID(),
    locked = store.locked.bind(store);
  let raced = false;
  t.mock.method(store, 'locked', (run, options) => {
    if (!raced) {
      raced = true;
      peer.locked(() => {
        const tx = peer.records();
        tx.patchFields('lanes', lane.laneId, { concurrentExtension: 'retained' });
        peer.commitRecords(tx);
      });
    }
    return locked(run, options);
  });
  await assert.rejects(
    agent.dispatch({ action: 'run', operationId, viewId: view.viewId, wait: true }),
    error => error.code === 'WORK_STALE',
  );
  assert.equal(store.select('runs', operationId), undefined);
  const result = await agent.dispatch({ action: 'run', operationId, viewId: view.viewId, wait: true });
  assert.equal(result.result.status, 'passed');
  assert.equal(store.load().runs.length, 1);
  assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
});

test('sync restores collected preparation outside the lock without merging or applying the workspace again', async t => {
  const { root, agent, store, peer, lane } = await fixture(t);
  const source = new NativeSource(root),
    files = source.state(lane.head).files;
  const target = source.writeState(
    files.map(file =>
      file.path === 'a.txt' ? { ...file, blob: source.put(Buffer.from('main a\n')) } : file,
    ),
    [lane.head],
    'Main',
    new Date().toISOString(),
  );
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: target,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  writeFileSync(join(lane.path, 'b.txt'), 'lane b\n');
  await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Diverged Lane' });
  const locked = store.locked.bind(store),
    compose = NativeSource.prototype.compose;
  const realNow = Date.now;
  let collectionDelay = 0;
  t.mock.method(Date, 'now', () => realNow() + collectionDelay);
  let collected = false,
    merges = 0;
  t.mock.method(NativeSource.prototype, 'compose', function (...args) {
    merges++;
    return compose.apply(this, args);
  });
  t.mock.method(store, 'locked', (run, options) => {
    if (!collected && options?.operation === 'sync publication') {
      collected = true;
      const result = nativeObjects(peer, { action: 'collect-native-objects' });
      assert.ok(result.result.removed.length > 0);
      // The initial collection can outlast lock patience without consuming retry time.
      collectionDelay += 2000;
    }
    return locked(run, options);
  });
  const result = await agent.dispatch({ action: 'sync', laneId: lane.laneId });
  assert.ok(collected);
  assert.equal(merges, 1);
  assert.equal(result.result.status, 'merged');
  assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'main a\n');
  for (const file of source.state(result.result.head).files) assert.ok(source.object(file.blob));
});

test('Git checkpoint and sync source operations stay outside owner commits and retain concurrent Lane metadata', async t => {
  const { root, agent, store, peer, lane } = await fixture(t, false);
  const other = (await agent.dispatch({ action: 'start', outcome: 'Independent Git Lane' })).result;
  writeFileSync(join(lane.path, 'a.txt'), 'main a\n');
  git(lane.path, 'add', 'a.txt');
  const landed = (
    await agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Git main', accept: true })
  ).result;
  writeFileSync(join(other.path, 'b.txt'), 'other b\n');
  git(other.path, 'add', 'b.txt');
  const locked = store.locked.bind(store);
  let raced = false;
  t.mock.method(store, 'locked', (run, options) => {
    if (!raced && options?.operation === 'Git checkpoint publication') {
      raced = true;
      peer.locked(() => {
        const tx = peer.records();
        tx.patchFields('lanes', other.laneId, { concurrentExtension: 'retained' });
        peer.commitRecords(tx);
      });
    }
    return locked(run, options);
  });
  const execute = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', function (...args) {
    if (args[0] === 'git') assert.equal(existsSync(join(store.directory, 'lock')), false);
    return execute.apply(this, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await agent.dispatch({ action: 'checkpoint', laneId: other.laneId, message: 'Git b' });
  const synced = await agent.dispatch({ action: 'sync', laneId: other.laneId });
  assert.ok(raced);
  assert.equal(synced.result.status, 'merged');
  assert.equal(readFileSync(join(other.path, 'a.txt'), 'utf8'), 'main a\n');
  assert.equal(readFileSync(join(other.path, 'b.txt'), 'utf8'), 'other b\n');
  assert.equal(store.select('lanes', other.laneId).concurrentExtension, 'retained');
  assert.equal(git(other.path, 'rev-parse', 'HEAD'), synced.result.head);
  assert.ok(git(root, 'show', `${synced.result.head}:b.txt`));
  const command = {
    operationId: randomUUID(),
    laneId: other.laneId,
    expectedHead: synced.result.head,
    message: 'Keep requested dependency',
  };
  const after = { viewId: landed.view.viewId };
  agentCheckpoint(store, command, { ...command, after }, { allowUnchanged: true });
  assert.deepEqual(store.select('lanes', other.laneId).after, after);
});

for (const changed of ['unrelated metadata', 'Lane head', 'Intent base'])
  test(`native composition revalidates ${changed} after preparing its pinned merge`, async t => {
    const { agent, store, peer, lane } = await fixture(t);
    writeFileSync(join(lane.path, 'a.txt'), 'composition source\n');
    const saved = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Composition' })
    ).result;
    const command = {
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: saved.head }],
      dependencies: [],
    };
    const compose = NativeSource.prototype.compose;
    let merges = 0;
    t.mock.method(NativeSource.prototype, 'compose', function (...args) {
      const result = compose.apply(this, args);
      if (args[2] === 'Native review composition') {
        merges++;
        peer.locked(() => {
          const tx = peer.records();
          if (changed === 'Lane head') tx.patchFields('lanes', lane.laneId, { head: lane.head });
          else if (changed === 'Intent base') tx.patchFields('intents', lane.intentId, { base: saved.head });
          else tx.patchFields('lanes', lane.laneId, { concurrentExtension: 'retained' });
          peer.commitRecords(tx);
        });
      }
      return result;
    });
    const publish = () => agent.work.dispatch(command, store.revision(), { reconcileComposition: true });
    if (changed === 'unrelated metadata') {
      const result = (await publish()).result;
      assert.equal(result.head, saved.head);
      assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
      assert.equal(store.load().views.length, 1);
      const replay = (await publish()).result;
      assert.equal(replay.id, result.id);
    } else {
      await assert.rejects(publish(), {
        code: changed === 'Lane head' ? 'LANE_STALE' : 'COMPOSITION_STALE',
      });
      assert.equal(store.load().views.length, 0, 'changed inputs never publish the prepared Candidate');
      if (changed === 'Lane head') assert.equal(store.select('lanes', lane.laneId).head, lane.head);
      else assert.equal(store.select('intents', lane.intentId).base, saved.head);
    }
    assert.equal(merges, 1, 'metadata admission never repeats the source merge');
  });

test('finish composition can observe current metadata while direct commands keep revision preconditions', async t => {
  const { agent, store, peer, lane } = await fixture(t);
  const revision = store.revision();
  peer.locked(() => {
    const tx = peer.records();
    tx.patchFields('lanes', lane.laneId, { concurrentExtension: 'retained' });
    peer.commitRecords(tx);
  });
  const command = {
    action: 'compose',
    operationId: randomUUID(),
    intentId: lane.intentId,
    inputs: [{ laneId: lane.laneId, head: lane.head }],
    dependencies: [],
  };
  await assert.rejects(agent.work.dispatch(command, revision), { code: 'WORK_STALE' });
  const result = await agent.work.dispatch(command, revision, { reconcileComposition: true });
  assert.equal(result.result.head, lane.head);
  assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
  assert.equal(store.load().views.length, 1);
});

test('start reconciles a transient controller admission ticket without duplicating its Lane', async t => {
  const { agent, store } = await fixture(t);
  const locked = store.locked.bind(store),
    operationId = randomUUID();
  let blocked = false;
  t.mock.method(store, 'locked', (run, options) => {
    if (!blocked && options?.operation === 'start reservation') {
      blocked = true;
      throw new ForgeError('WORK_BUSY', 'Controller is publishing its original completion.');
    }
    return locked(run, options);
  });
  const command = { action: 'start', operationId, outcome: 'Concurrent controller completion' };
  const first = (await agent.dispatch(command)).result;
  assert.ok(blocked);
  const replay = (await agent.dispatch(command)).result;
  assert.equal(replay.laneId, first.laneId);
  assert.equal(store.load().lanes.filter(lane => lane.intentId === first.intentId).length, 1);
  assert.equal(store.select('lanes', first.laneId).state, 'active');
});
