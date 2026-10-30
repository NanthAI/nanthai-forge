// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { rmSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause, setImmediate as yieldTurn } from 'node:timers/promises';

// Keep handles for in-process workers and checks; a Promise alone cannot join an unref'd child.
const children = new Map();
const knownPresence = new Map();
// A fixture that spawns a grandchild can retain its exact identity before the
// worker publishes a lease; discovering arbitrary process arguments is unsafe.
export function registerOwnerPresence(root, identity) {
  assertSyntheticOwner(root);
  assert.ok(identity.startTime && identity.pid !== process.pid);
  const canonical = realpathSync(root);
  const registered = knownPresence.get(canonical) ?? new Map();
  registered.set(identity.pid, { ...identity, worker: 'presence-worker' });
  knownPresence.set(canonical, registered);
}
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  const entry = {
    args: Array.isArray(args[1]) ? args[1] : [],
    cwd: (Array.isArray(args[1]) ? args[2] : args[1])?.cwd,
    closed: new Promise(resolve => child.once('close', resolve)),
  };
  children.set(child, entry);
  void entry.closed.then(() => children.delete(child));
  return child;
};
syncBuiltinESMExports();

// Discover only this synthetic owner's durable leases and markers. Never inspect
// machine-wide command arguments (which can include unrelated credentials).
function ownerWorkers(roots, _workerDirectory, { processAlive }, WorkStore, stopChecks = false) {
  const workers = new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const registered = knownPresence.get(realpathSync(root));
    for (const [pid, identity] of registered ?? []) {
      if (processAlive(identity)) workers.set(pid, identity);
      else registered.delete(pid);
    }
    if (!registered?.size) knownPresence.delete(realpathSync(root));
    if (!existsSync(join(root, '.forge', 'native.json')) && !existsSync(join(root, '.git'))) continue;
    const store = new WorkStore(root),
      directory = store.directory;
    if (!directory.startsWith(realpathSync(root) + sep)) continue;
    if (!existsSync(directory)) continue;
    const queue = (path, worker, runId) => {
      if (!existsSync(path)) return;
      for (const name of readdirSync(path)) {
        const match = /^(\d+)\.([\w-]+)\.([\w-]+)$/.exec(name);
        if (!match) continue;
        const pid = Number(match[1]),
          startTime = Buffer.from(match[2], 'base64url').toString();
        if (pid === process.pid || !processAlive({ pid, startTime })) continue;
        if (
          worker === 'presence-worker' &&
          !existsSync(join(directory, 'presence-worker-' + pid + '.marker'))
        )
          continue;
        workers.set(pid, { pid, startTime, worker, lease: true, runId });
      }
    };
    // A submitting CLI may have exited before its finite weekly child starts.
    // The reservation is removed only after all snapshot writes have finished.
    const metrics = join(directory, 'metrics');
    if (existsSync(metrics))
      for (const name of readdirSync(metrics))
        if (/^\.weekly-.*\.pending$/.test(name))
          workers.set(join(metrics, name), { worker: 'self-metrics-weekly-worker' });
    queue(join(directory, 'presence-owner'), 'presence-worker');
    queue(join(directory, 'agent-advisory', 'drain'), 'agent-advisory-worker');
    queue(join(directory, 'integration-preview-drain'), 'integration-preview-worker');
    queue(join(directory, 'post-accept-main-queue'), 'post-accept-main');
    const controllers = join(directory, 'check-controllers');
    if (existsSync(controllers))
      for (const name of readdirSync(controllers)) queue(join(controllers, name), 'check-controller', name);
    // A detached controller can still be starting after its submitting CLI exits.
    // Its durable unstarted reservation prevents teardown from removing its owner.
    const tx = store.readRecords();
    const runs = tx
      ? ['queued', 'preparing', 'running'].flatMap(status =>
          tx.positions('runs', status, 'status').map(p => tx.at('runs', p)),
        )
      : store.load().runs;
    for (const run of runs) {
      if (!['queued', 'preparing', 'running'].includes(run.status)) continue;
      const path = join(directory, 'check-' + run.id, 'controller-request.json');
      if (!processAlive(run.runner) && (stopChecks || run.status !== 'queued')) continue;
      if (existsSync(path) && !existsSync(join(directory, 'check-' + run.id, 'result.json')))
        workers.set(run.id, {
          worker: 'check-controller',
          pid: run.runner.pid,
          startTime: run.runner.startTime,
        });
    }
  }
  return [...workers.values()];
}

function assertSyntheticOwner(root) {
  const canonical = realpathSync(root);
  assert.ok(
    canonical.startsWith(realpathSync(tmpdir()) + sep) && basename(canonical).startsWith('forge-'),
    'Controller teardown is limited to synthetic temporary Forge owners',
  );
}

function sameProcess(processes, identity) {
  try {
    return (
      processes.processAlive(identity) &&
      processes.processIdentity(identity.pid).startTime === identity.startTime
    );
  } catch {
    return false; // An unknown kernel identity never authorizes a signal.
  }
}

export async function stopOwnerCheckControllers(root) {
  assertSyntheticOwner(root);
  const processes = await import('../dist/local-process.js');
  const { WorkStore } = await import('../dist/work-store.js');
  const { wakeLandingWorker } = await import('../dist/landing-worker-wake.js');
  const { createRunReceipt } = await import('../dist/work-run-receipt.js');
  const { durableReplace } = await import('../dist/native-durability.js');
  const store = new WorkStore(root);
  assert.equal(store.root, realpathSync(root), 'A Lane must never resolve teardown into its real owner');
  assert.ok(
    store.directory.startsWith(realpathSync(root) + sep),
    'Teardown metadata must belong to the temporary owner',
  );
  for (const worker of ownerWorkers([realpathSync(root)], undefined, processes, WorkStore, true)) {
    if (worker.worker !== 'check-controller' || !worker.lease || !sameProcess(processes, worker)) continue;
    // End synthetic reservations before the signal: a parent's normal recovery
    // hook must not respawn a remote controller during failed-test teardown.
    store.locked(() => {
      const tx = store.records(),
        selected = tx.find('runs', worker.runId);
      if (!selected || !['queued', 'preparing', 'running'].includes(selected.record.status)) return;
      const path = join(store.directory, `check-${worker.runId}`, 'result.json');
      if (existsSync(path)) return;
      const receipt = createRunReceipt({
        status: 'interrupted',
        backend: selected.record.backend,
        endedAt: new Date().toISOString(),
        exitCode: null,
        signal: 'SIGTERM',
        error: {
          code: 'SYNTHETIC_TEST_TEARDOWN',
          message: 'Synthetic test controller stopped during teardown.',
        },
        details: 'Synthetic test cleanup; the temporary owner will be removed.',
      });
      durableReplace(path, JSON.stringify(receipt));
      Object.assign(selected.record, receipt, { cancelRequested: true });
      tx.replace('runs', selected.position, selected.record);
      store.commitRecords(tx);
    });
    if (!sameProcess(processes, worker)) continue;
    try {
      process.kill(worker.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  wakeLandingWorker(store);
}

export async function waitForOwnerChildren(
  root,
  workerDirectory = resolve('dist'),
  { stopChecks = false } = {},
) {
  // Package smoke builds dist itself; importing the helper must work before that build.
  const { drainAgentAdvisories } = await import('../dist/agent-advisory-worker.js');
  if (existsSync(join(root, '.forge', 'native.json')) || existsSync(join(root, '.git')))
    await drainAgentAdvisories(root);
  const processes = await import('../dist/local-process.js');
  const { WorkStore } = await import('../dist/work-store.js');
  const roots = [...new Set([resolve(root), realpathSync(root)])];
  const belongs = entry =>
    roots.some(root => entry.args.includes(root) || entry.cwd === root || entry.cwd?.startsWith(root + sep));
  const deadline = Date.now() + 240_000;
  for (;;) {
    // Saved events launch previews on setImmediate, including during a preceding child's close.
    await yieldTurn();
    const pending = [...children].filter(([, entry]) => belongs(entry));
    for (const [child] of pending) child.ref();
    let publishing = false;
    if (stopChecks) {
      try {
        await stopOwnerCheckControllers(root);
      } catch (error) {
        if (error.code !== 'WORK_BUSY') throw error;
        // The controller can still be publishing after its caller exits. Join
        // under this cleanup loop's existing deadline before stopping it.
        publishing = true;
      }
    }
    const owned = ownerWorkers(roots, workerDirectory, processes, WorkStore, stopChecks);
    for (const worker of owned) {
      // Presence is deliberately long-lived. Finite preview/audit workers finish their writes normally.
      if (worker.worker === 'presence-worker' && sameProcess(processes, worker)) {
        try {
          process.kill(worker.pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    if (!publishing && !pending.length && !owned.length) return;
    assert.ok(
      Date.now() < deadline,
      `Owner teardown still has ${pending.length} child handles and ${owned.length} workers`,
    );
    // A referenced timer also keeps the join alive while joining a detached child discovered through its lease.
    await pause(100);
  }
}

export async function cleanupOwner(root, workerDirectory, options) {
  await waitForOwnerChildren(root, workerDirectory, options);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
