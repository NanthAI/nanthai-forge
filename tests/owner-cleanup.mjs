// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { rmSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';
import { setTimeout as pause, setImmediate as yieldTurn } from 'node:timers/promises';

// Keep handles for in-process workers and checks; a Promise alone cannot join an unref'd child.
const children = new Map();
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

const workers = ['presence-worker', 'integration-preview-worker', 'post-accept-main'];
function ownerWorkers(roots, workerDirectory, { processAlive, processStartTime }) {
  // CLI workers outlive their original process. Match only the selected build's worker script and owner
  // argument within the removed directory; never signal an unrelated owner or expose the process table in diagnostics.
  const rows = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' });
  return rows.split('\n').flatMap(row => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row);
    if (!match) return [];
    const worker = workers.find(name =>
      roots.some(root => {
        const script = ` ${resolve(workerDirectory, `${name}.js`)} `;
        const start = match[2].indexOf(script);
        if (start < 0) return false;
        const owner = match[2].slice(start + script.length);
        return owner === root || owner.startsWith(root + sep);
      }),
    );
    if (!worker) return [];
    const pid = Number(match[1]),
      startTime = processStartTime(pid);
    return startTime && processAlive({ pid, startTime }) ? [{ pid, startTime, worker }] : [];
  });
}

export async function waitForOwnerChildren(root, workerDirectory = resolve('dist')) {
  // Package smoke builds dist itself; importing the helper must work before that build.
  const processes = await import('../dist/local-process.js');
  const roots = [...new Set([resolve(root), realpathSync(root)])];
  const belongs = entry =>
    roots.some(root => entry.args.includes(root) || entry.cwd === root || entry.cwd?.startsWith(root + sep));
  const deadline = Date.now() + 240_000;
  for (;;) {
    // Saved events launch previews on setImmediate, including during a preceding child's close.
    await yieldTurn();
    const pending = [...children].filter(([, entry]) => belongs(entry));
    for (const [child] of pending) child.ref();
    const owned = ownerWorkers(roots, workerDirectory, processes);
    for (const worker of owned) {
      // Presence is deliberately long-lived. Finite preview/audit workers finish their writes normally.
      if (worker.worker === 'presence-worker' && processes.processAlive(worker)) {
        try {
          process.kill(worker.pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    if (!pending.length && !owned.length) return;
    assert.ok(
      Date.now() < deadline,
      `Owner teardown still has ${pending.length} child handles and ${owned.length} workers`,
    );
    // A referenced timer also keeps the join alive while joining a detached child discovered via ps.
    await pause(100);
  }
}

export async function cleanupOwner(root, workerDirectory) {
  await waitForOwnerChildren(root, workerDirectory);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
