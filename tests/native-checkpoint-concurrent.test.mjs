// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { nativeObjects } from '../dist/native-objects.js';
import { ForgeError } from '../dist/errors.js';

async function fixture(t, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'forge-concurrent-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.txt'), 'original\n');
  writeFileSync(join(root, 'stable.txt'), 'unchanged\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    lanes = [];
  for (let index = 0; index < count; index++) {
    const lane = (
      await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: `Synthetic ${index}` })
    ).result;
    writeFileSync(join(lane.path, 'source.txt'), `changed ${index}\n`);
    lanes.push(lane);
  }
  const command = lane => ({
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Save synthetic change',
  });
  return { root, agent, lanes, command };
}
const imports = `import {AgentWorkflow} from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};import {WorkStore} from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};`;
function worker(root, command, before = '') {
  return spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${imports}${before}console.log(JSON.stringify(await new AgentWorkflow(process.argv[1]).dispatch(JSON.parse(process.argv[2]))));`,
      root,
      JSON.stringify(command),
    ],
    { env: { ...process.env, FORGE_WORK_LOCK_WAIT_MS: '60000' } },
  );
}
function result(child) {
  return new Promise((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout.on('data', bytes => (output += bytes));
    child.stderr.on('data', bytes => (error += bytes));
    child.on('error', reject);
    child.on('exit', code =>
      code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`${code}: ${error}${output}`)),
    );
  });
}

test('20 independent Lanes checkpoint concurrently without lost records; original operations replay', async t => {
  const f = await fixture(t, 20),
    commands = f.lanes.map(f.command);
  const replies = await Promise.all(commands.map(command => result(worker(f.root, command))));
  const data = new WorkStore(f.root).load(),
    source = new NativeSource(f.root);
  assert.equal(data.lanes.length, 20);
  for (const [index, lane] of f.lanes.entries()) {
    const stored = data.lanes.find(item => item.id === lane.laneId);
    assert.equal(stored.checkpoints.length, 1);
    assert.equal(stored.head, replies[index].result.head);
    assert.equal(stored.checkpoints[0].parent, lane.head);
    const state = source.state(stored.head);
    assert.deepEqual(state.parents, [lane.head]);
    assert.equal(source.object(state.files[0].blob).toString(), `changed ${index}\n`);
    assert.equal((await f.agent.dispatch(commands[index])).result.head, stored.head);
  }
  assert.equal(
    new WorkStore(f.root).load().lanes.reduce((n, lane) => n + lane.checkpoints.length, 0),
    20,
  );
});

test('object verification and State writes stay outside the publication lock, including collection retry', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    locked = store.locked.bind(store);
  const originalObject = NativeSource.prototype.object,
    originalWrite = NativeSource.prototype.writeState;
  let inside = false,
    raced = false,
    states = 0;
  store.locked = (run, options) => {
    if (!raced) {
      raced = true;
      const removed = nativeObjects(new WorkStore(f.root), { action: 'collect-native-objects' }).result
        .removed;
      assert.ok(removed.length >= 2);
    }
    return locked(() => {
      inside = options?.operation === 'checkpoint publication';
      try {
        return run();
      } finally {
        inside = false;
      }
    }, options);
  };
  NativeSource.prototype.object = function (...args) {
    assert.equal(inside, false, 'object bytes under owner lock');
    return originalObject.apply(this, args);
  };
  NativeSource.prototype.writeState = function (...args) {
    assert.equal(inside, false, 'State write under owner lock');
    states++;
    return originalWrite.apply(this, args);
  };
  t.after(() => {
    NativeSource.prototype.object = originalObject;
    NativeSource.prototype.writeState = originalWrite;
  });
  const reply = await f.agent.dispatch(f.command(f.lanes[0]));
  assert.ok(states >= 2, 'collected objects trigger preparation retry');
  assert.equal(store.load().lanes[0].head, reply.result.head);
});

test('legacy Work migration retries preparation outside the owner publication lock', async t => {
  const f = await fixture(t),
    store = f.agent.work.store;
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(store.load()));
  assert.equal(store.readRecords(), undefined);
  const locked = store.locked.bind(store),
    capture = NativeSource.prototype.captureReport;
  let inside = false,
    captures = 0;
  store.locked = (run, options) =>
    locked(() => {
      inside = options?.operation === 'checkpoint publication';
      try {
        return run();
      } finally {
        inside = false;
      }
    }, options);
  NativeSource.prototype.captureReport = function (...args) {
    assert.equal(inside, false);
    captures++;
    return capture.apply(this, args);
  };
  t.after(() => {
    NativeSource.prototype.captureReport = capture;
  });
  await f.agent.dispatch(f.command(f.lanes[0]));
  assert.equal(captures, 1);
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});

test('Lane head CAS rejects a stale candidate; refreshing the pin retains both checkpoints', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    locked = store.locked.bind(store);
  const lane = f.lanes[0],
    source = new NativeSource(f.root);
  let peerHead;
  store.locked = (run, options) => {
    store.locked = locked;
    const peer = new WorkStore(f.root),
      at = new Date().toISOString();
    peerHead = source.writeState(source.state(lane.head).files, [lane.head], 'Concurrent checkpoint', at);
    peer.locked(() => {
      const tx = peer.records();
      tx.appendField('lanes', lane.laneId, 'checkpoints', {
        head: peerHead,
        parent: lane.head,
        message: 'Concurrent checkpoint',
        at,
      });
      tx.patchFields('lanes', lane.laneId, { head: peerHead });
      peer.commitRecords(tx);
    });
    return locked(run, options);
  };
  await assert.rejects(f.agent.dispatch(f.command(lane)), error => error.code === 'LANE_STALE');
  const reply = await f.agent.dispatch({ ...f.command(lane), expectedHead: peerHead });
  const saved = store.load().lanes[0];
  assert.equal(saved.checkpoints.length, 2);
  assert.equal(saved.head, reply.result.head);
  assert.deepEqual(source.state(saved.head).parents, [peerHead]);
  assert.equal(saved.checkpoints[0].head, peerHead);
});

test('unrelated object insertion does not retry an independent prepared checkpoint', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    locked = store.locked.bind(store);
  let publications = 0;
  store.locked = (run, options) => {
    if (options?.operation === 'checkpoint publication') {
      publications++;
      new NativeSource(f.root).put(Buffer.from('unrelated concurrent object'));
    }
    return locked(run, options);
  };
  await f.agent.dispatch(f.command(f.lanes[0]));
  assert.equal(publications, 1);
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});

test('object corruption between preparation and publication never advances the Lane head', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    locked = store.locked.bind(store);
  store.locked = (run, options) => {
    store.locked = locked;
    const source = new NativeSource(f.root);
    // This is the freshly prepared changed file, not the retained original blob.
    const bytes = Buffer.from('changed 0\n');
    const id = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(source.directory, id), 'corrupted candidate');
    return locked(run, options);
  };
  await assert.rejects(
    f.agent.dispatch(f.command(f.lanes[0])),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
  assert.equal(store.load().lanes[0].head, f.lanes[0].head);
  assert.equal(store.load().lanes[0].checkpoints.length, 0);
});

test('atomic Work pointer read races retry metadata without repeating source capture', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    read = store.readRecords.bind(store);
  const capture = NativeSource.prototype.captureReport;
  let reads = 0,
    captures = 0;
  store.readRecords = () => {
    reads++;
    if (reads === 1 || reads === 3)
      throw new ForgeError('SOURCE_CHANGED', 'Synthetic Work pointer replacement');
    return read();
  };
  NativeSource.prototype.captureReport = function (...args) {
    captures++;
    return capture.apply(this, args);
  };
  t.after(() => {
    NativeSource.prototype.captureReport = capture;
  });
  await f.agent.dispatch(f.command(f.lanes[0]));
  assert.equal(captures, 1);
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});

test('Work CAS retries metadata without recapturing source or losing an unrelated write', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    locked = store.locked.bind(store);
  const capture = NativeSource.prototype.captureReport;
  let publications = 0,
    captures = 0;
  NativeSource.prototype.captureReport = function (...args) {
    captures++;
    return capture.apply(this, args);
  };
  t.after(() => {
    NativeSource.prototype.captureReport = capture;
  });
  store.locked = (run, options) => {
    if (options?.operation === 'checkpoint publication' && publications++ === 0) {
      const peer = new WorkStore(f.root);
      peer.locked(() => {
        const tx = peer.records();
        tx.patchFields('intents', f.lanes[0].intentId, { outcome: 'Concurrent metadata' });
        peer.commitRecords(tx);
      });
    }
    return locked(run, options);
  };
  await f.agent.dispatch(f.command(f.lanes[0]));
  assert.ok(publications >= 2);
  assert.equal(captures, 1);
  assert.equal(store.load().intents[0].outcome, 'Concurrent metadata');
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});

test('checkpoint record and index pages are staged outside the owner lock', async t => {
  const f = await fixture(t),
    store = f.agent.work.store,
    locked = store.locked.bind(store);
  const rename = fs.renameSync;
  let inside = false,
    pages = 0;
  store.locked = (run, options) =>
    locked(() => {
      inside = ['checkpoint selection', 'checkpoint publication'].includes(options?.operation);
      try {
        return run();
      } finally {
        inside = false;
      }
    }, options);
  fs.renameSync = (from, to) => {
    if (dirname(to) === join(store.directory, 'records')) {
      assert.equal(inside, false, 'immutable Work page written under owner lock');
      pages++;
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  });
  await f.agent.dispatch(f.command(f.lanes[0]));
  assert.ok(pages > 0);
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});

test('process death after durable objects but before record append preserves head and retries exactly once', async t => {
  const f = await fixture(t),
    command = f.command(f.lanes[0]);
  const before = readFileSync(join(f.agent.work.store.directory, 'work.json'));
  const child = worker(f.root, command, 'WorkStore.prototype.commitRecords = function(){process.exit(73)};');
  await assert.rejects(result(child), /73:/);
  assert.deepEqual(readFileSync(join(f.agent.work.store.directory, 'work.json')), before);
  assert.equal(new WorkStore(f.root).load().lanes[0].head, f.lanes[0].head);
  const reply = await f.agent.dispatch(command);
  assert.equal((await f.agent.dispatch(command)).result.head, reply.result.head);
  assert.equal(new WorkStore(f.root).load().lanes[0].checkpoints.length, 1);
});
