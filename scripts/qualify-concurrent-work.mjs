// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const script = fileURLToPath(import.meta.url),
  checkout = dirname(dirname(script));
async function runtimeAt(root) {
  const load = name => import(pathToFileURL(join(root, 'dist', name + '.js')).href);
  const [{ AgentWorkflow }, { WorkStore }, { NativeSource }, { initNative }] = await Promise.all(
    ['agent-workflow', 'work-store', 'native-source', 'native-work'].map(load),
  );
  return { AgentWorkflow, WorkStore, NativeSource, initNative };
}
async function worker() {
  process.send({ ready: true });
  const job = await new Promise(resolve => process.once('message', resolve));
  // The shared test preload selects immediate WORK_BUSY; this fixture opts into
  // queue patience after that preload has run in the forked process.
  process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
  const { AgentWorkflow, WorkStore } = await runtimeAt(job.runtime),
    agent = new AgentWorkflow(job.root);
  const locks = { calls: 0, acquired: 0, heldMs: 0, successfulMs: 0, busyMs: 0, fsyncs: 0, lockedFsyncs: 0 },
    locked = WorkStore.prototype.locked;
  let attempting = false;
  const fsync = fs.fsyncSync;
  fs.fsyncSync = (...args) => {
    locks.fsyncs++;
    if (attempting) locks.lockedFsyncs++;
    return fsync(...args);
  };
  syncBuiltinESMExports();
  WorkStore.prototype.locked = function (run) {
    const at = performance.now();
    locks.calls++;
    attempting = true;
    try {
      const result = locked.call(this, () => {
        const acquired = performance.now();
        locks.acquired++;
        try {
          return run();
        } finally {
          locks.heldMs += performance.now() - acquired;
        }
      });
      locks.successfulMs += performance.now() - at;
      return result;
    } catch (error) {
      if (error.code === 'WORK_BUSY') locks.busyMs += performance.now() - at;
      throw error;
    } finally {
      attempting = false;
    }
  };
  const retries = { WORK_BUSY: 0, WORK_STALE: 0, SOURCE_CHANGED: 0 },
    receipts = [],
    started = performance.now(),
    retryDeadline = started + 180000;
  async function original(command, client = agent) {
    for (;;) {
      try {
        const value = await client.dispatch(command);
        receipts.push({ command, value });
        return value.result;
      } catch (error) {
        if (!Object.hasOwn(retries, error.code) || performance.now() >= retryDeadline) throw error;
        retries[error.code]++;
        await new Promise(resolve => setTimeout(resolve, 10 + job.index * 3));
      }
    }
  }
  let lane = job.lane;
  if (!lane) {
    lane = await original(job.start);
    for (;;) {
      try {
        await agent.work.dispatch(
          {
            action: 'note',
            intentId: lane.intentId,
            kind: 'decision',
            text: `Independent client ${job.index}`,
          },
          agent.work.store.revision(),
        );
        break;
      } catch (error) {
        if (!Object.hasOwn(retries, error.code) || performance.now() >= retryDeadline) throw error;
        retries[error.code]++;
        await new Promise(resolve => setTimeout(resolve, 10 + job.index * 3));
      }
    }
  }
  writeFileSync(
    join(lane.path, job.conflict ? 'shared.txt' : `worker-${job.index}.txt`),
    job.conflict ? `conflicting client ${job.index}\n` : `independent client ${job.index}\n`,
  );
  const command = {
    action: 'checkpoint',
    operationId: job.checkpointId,
    laneId: lane.laneId,
    expectedHead: job.expectedHead ?? lane.head,
    message: job.conflict ? 'Intentional shared-line edit' : 'Independent file edit',
  };
  const checkpoint = await original(command);
  if (job.index === 0) {
    // Deliberately discard the successful reply, then reconcile the exact same
    // request through a new client; do not invent a replacement operation.
    // Hosted delivery is advisory and can be deferred under contention; the
    // reconciled source receipt remains exact regardless of that current status.
    // Peers are likewise a live advisory observation of other Lanes, not receipt state.
    const { hostedSync: _initialDelivery, peers: _initialPeers, ...initialSource } = checkpoint;
    const {
      hostedSync: _replayedDelivery,
      peers: _replayedPeers,
      ...replayedSource
    } = await original(command, new AgentWorkflow(job.root));
    assert.deepEqual(replayedSource, initialSource);
  }
  const view = await original({
    action: 'compose',
    operationId: job.composeId,
    intentId: lane.intentId,
    inputs: [{ laneId: lane.laneId, head: checkpoint.head }],
  });
  process.send({
    result: {
      index: job.index,
      lane,
      checkpoint,
      view,
      retries,
      receipts,
      locks,
      elapsedMs: performance.now() - started,
      originalCheckpointReconciled: job.index === 0,
    },
  });
  process.disconnect();
}
async function clients(jobs) {
  const children = [],
    ready = [],
    results = [];
  try {
    for (const job of jobs) {
      // Exercise the queue-aware writer with explicit fixture patience under shared load.
      const child = fork(script, ['--worker'], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, FORGE_WORK_LOCK_WAIT_MS: '10000' },
      });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
      ready.push(
        new Promise((resolve, reject) => {
          child.on('message', value => {
            if (value.ready) resolve();
          });
          child.once('error', reject);
          child.once('exit', code => {
            if (code) reject(Error(stderr || `Client exited ${code}`));
          });
        }),
      );
      results.push(
        new Promise((resolve, reject) => {
          child.on('message', value => {
            if (value.result) resolve(value.result);
            if (value.error) reject(Error(value.error));
          });
          child.once('error', reject);
          child.once('exit', code => {
            if (code) reject(Error(stderr || `Client exited ${code}`));
          });
        }),
      );
    }
    await Promise.all(ready);
    children.forEach((child, index) => child.send(jobs[index]));
    const settled = await Promise.allSettled(results),
      failure = settled.find(value => value.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map(value => value.value);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}
export async function qualifyConcurrentWork(runtime = process.env.FORGE_QUALIFY_RUNTIME ?? checkout) {
  const { AgentWorkflow, WorkStore, NativeSource, initNative } = await runtimeAt(runtime),
    root = mkdtempSync(join(tmpdir(), 'forge-eight-clients-')),
    started = performance.now();
  try {
    writeFileSync(join(root, 'shared.txt'), 'original shared line\n');
    initNative(root);
    const store = new WorkStore(root),
      initial = store.load();
    initial.futureExtension = { original: ['preserve', 8] };
    store.save(initial);
    const jobs = Array.from({ length: 8 }, (_, index) => ({
      runtime,
      root,
      index,
      start: {
        action: 'start',
        operationId: randomUUID(),
        outcome: `Independent process client ${index}`,
        channel: null,
      },
      checkpointId: randomUUID(),
      composeId: randomUUID(),
    }));
    const independentStarted = performance.now(),
      workers = await clients(jobs),
      independentMs = performance.now() - independentStarted;
    const agent = new AgentWorkflow(root),
      integration = (
        await agent.dispatch({
          action: 'start',
          operationId: randomUUID(),
          outcome: 'Combine independent client work',
          channel: null,
        })
      ).result;
    const compose = async views =>
      (
        await agent.dispatch({
          action: 'compose',
          operationId: randomUUID(),
          intentId: integration.intentId,
          inputs: [],
          dependencies: views.map(view => ({ kind: 'view', viewId: view.viewId, head: view.head })),
        })
      ).result;
    const clean = await compose(workers.map(worker => worker.view));
    assert.equal(clean.status, 'clean');
    const source = new NativeSource(root),
      files = source.state(clean.head).files;
    for (const worker of workers)
      assert.equal(
        source.object(files.find(file => file.path === `worker-${worker.index}.txt`).blob).toString(),
        `independent client ${worker.index}\n`,
      );
    const concurrent = await clients(
      workers.slice(0, 2).map(worker => ({
        runtime,
        root,
        index: worker.index,
        lane: worker.lane,
        expectedHead: worker.checkpoint.head,
        conflict: true,
        checkpointId: randomUUID(),
        composeId: randomUUID(),
      })),
    );
    const conflict = await compose([
      ...concurrent.map(worker => worker.view),
      ...workers.slice(2).map(worker => worker.view),
    ]);
    assert.equal(conflict.status, 'conflict');
    assert.match(conflict.conflicts, /shared.txt/);
    const originalConflict = structuredClone(store.load().views.find(view => view.id === conflict.viewId));
    for (const file of files) {
      const path = join(integration.path, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source.object(file.blob));
    }
    writeFileSync(join(integration.path, 'shared.txt'), 'explicitly resolved shared line\n');
    const resolutionCheckpoint = (
      await agent.dispatch({
        action: 'checkpoint',
        operationId: randomUUID(),
        laneId: integration.laneId,
        expectedHead: integration.head,
        message: 'Explicit shared-line resolution retaining all independent edits',
      })
    ).result;
    const resolutionCommand = {
      action: 'resolve-native-view',
      operationId: randomUUID(),
      viewId: conflict.viewId,
      laneId: integration.laneId,
      expectedHead: resolutionCheckpoint.head,
    };
    const resolution = (await agent.work.dispatch(resolutionCommand, store.revision())).result;
    assert.equal(resolution.status, 'clean');
    assert.equal(resolution.resolution.viewId, conflict.viewId);
    const final = store.load();
    assert.deepEqual(final.futureExtension, initial.futureExtension);
    assert.deepEqual(
      final.views.find(view => view.id === conflict.viewId),
      originalConflict,
    );
    for (const worker of workers) {
      assert.equal(
        final.intents
          .find(intent => intent.id === worker.lane.intentId)
          .notes.filter(note => note.text === `Independent client ${worker.index}`).length,
        1,
      );
      assert.equal(
        final.lanes
          .find(lane => lane.id === worker.lane.laneId)
          .checkpoints.filter(cp => cp.operation?.id === worker.checkpoint.operationId).length,
        1,
      );
      assert.ok(
        source.ancestors(resolution.head).has(worker.checkpoint.head),
        'Resolved source retains independent original ancestry',
      );
    }
    const resolved = source.state(resolution.head).files;
    for (const worker of workers)
      assert.equal(
        source.object(resolved.find(file => file.path === `worker-${worker.index}.txt`).blob).toString(),
        `independent client ${worker.index}\n`,
      );
    assert.equal(
      source.object(resolved.find(file => file.path === 'shared.txt').blob).toString(),
      'explicitly resolved shared line\n',
    );
    return {
      runtime,
      node: process.version,
      platform: process.platform,
      independentClients: 8,
      conflictClients: 2,
      independentMs,
      totalMs: performance.now() - started,
      workers,
      conflictWorkers: concurrent,
      clean,
      conflict,
      resolutionCommand,
      resolution: { id: resolution.id, head: resolution.head, status: resolution.status },
      finalRevision: final.revision,
      unknownFieldsPreserved: true,
      originalConflictPreserved: true,
      sourceFilesVerified: 9,
      syntheticOwnerRemoved: true,
      qualification:
        'Eight concurrent OS process clients plus two conflict-phase processes, using real local Forge operations and a shared disposable native owner. Not eight models, a live hosted test, a production-load benchmark or a general concurrency guarantee. Known lock/stale/source-change outcomes are retried with original operation identities; timings include process startup and filesystem work.',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === '--worker') {
  try {
    await worker();
  } catch (error) {
    process.send?.({ error: error.stack ?? String(error) });
    process.disconnect?.();
    process.exitCode = 1;
  }
} else if (process.argv[1] && resolve(process.argv[1]) === script) {
  const output = process.argv[2];
  assert(output, 'Supply a private result JSON path');
  const result = await qualifyConcurrentWork();
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      independentClients: result.independentClients,
      independentMs: result.independentMs,
      totalMs: result.totalMs,
      status: 'passed',
      output,
    }),
  );
}
