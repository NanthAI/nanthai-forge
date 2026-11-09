// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { watchLocal } from '../dist/local-watcher.js';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { shortSocketPath } from './helpers/short-socket.mjs';
import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { readMainAuditState } from '../dist/post-accept-state.js';

// Subscribe before reading; coalesce writes rather than decoding all Work every
// 30 ms. Keep the original 20-second failure bound and reread at that boundary.
export function until(f, read, message, signal, limitMs = 20_000) {
  const states = join(f.store.directory, 'landing-workers');
  mkdirSync(states, { recursive: true });
  return new Promise((resolve, reject) => {
    const watchers = [];
    let timer,
      fallback,
      scheduled,
      settled = false;
    const close = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(fallback);
      clearImmediate(scheduled);
      for (const watcher of watchers) watcher.close();
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(result);
    };
    const check = () => {
      try {
        const result = read();
        if (result) close(undefined, result);
      } catch (error) {
        close(error);
      }
    };
    const changed = () => {
      if (settled || scheduled) return;
      scheduled = setImmediate(() => {
        scheduled = undefined;
        check();
      });
    };
    const aborted = () => close(signal.reason);
    try {
      // Exact directories avoid depending on recursive watcher discovery of a
      // newly created landing-workers directory (notably macOS FSEvents).
      for (const path of [f.store.directory, states]) {
        const watcher = watchLocal(path, {}, changed);
        watchers.push(watcher);
      }
      signal?.addEventListener('abort', aborted, { once: true });
      // Native directory watchers can miss their first events on macOS. This
      // test-only fallback observes durable state; it never drives the worker.
      fallback = setInterval(check, 250);
      timer = setTimeout(() => {
        check();
        if (!settled) {
          const data = f.store.load();
          close(
            new Error(
              `${message}: ${JSON.stringify({
                workers: landingWorkerStates(f.store),
                entries: data.landingEntries?.map(({ id, status }) => ({ id, status })),
                runs: data.runs.map(({ id, status, error, failureSummary }) => ({
                  id,
                  status,
                  error,
                  failureSummary,
                })),
              })}`,
            ),
          );
        }
      }, limitMs);
      if (signal?.aborted) aborted();
      else changed();
    } catch (error) {
      close(error);
    }
  });
}

// The command may connect its socket before its PID has been published in Work.
// Restart drills must pin the durable child identity before signalling anything.
export function runningChildRun(store) {
  const tx = store.readRecords();
  try {
    return tx.all('runs', 'running', 'status').find(run => run.childPid);
  } finally {
    tx.dispose();
  }
}

// Accepting a landing wakes a detached main-audit driver. It starts a moment
// after the landing is complete and keeps publishing Work (post-accept move,
// main-check run, run progress) until it saves `idle`. The landing is complete
// before that, so a Work revision sampled right after `complete` is only
// comparable once the audit is over. The audit has its own wall bound: it runs
// a real check process, which load can stretch.
export function mainAuditSettled(f, signal) {
  return until(
    f,
    () => readMainAuditState(f.store)?.status === 'idle' && f.store.load().runs.every(run => run.endedAt),
    'main audit settled',
    signal,
    60_000,
  );
}

export function settledLandingEntries(store, ids) {
  return ids.every(id => {
    const entry = store.select('landingEntries', id);
    return entry && !['queued', 'checking'].includes(entry.status);
  });
}

export async function childWorker(f, { filesystem = true, env = process.env, ready } = {}) {
  const script = `import { watcherRuntime } from ${JSON.stringify(new URL('../dist/local-watcher.js', import.meta.url).href)};
import { FakeWatchWorker } from ${JSON.stringify(new URL('./local-watcher-fixture.mjs', import.meta.url).href)};
${filesystem ? '' : `watcherRuntime.createWorker = () => new FakeWatchWorker({ silent: true });`}
import { WorkStore } from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};
import { watchLandingWorker } from ${JSON.stringify(new URL('../dist/landing-worker.js', import.meta.url).href)};
const c=new AbortController();process.on('SIGTERM',()=>c.abort());
await watchLandingWorker(new WorkStore(process.argv[1]),c.signal);`;
  // check-runtime.mjs sets zero lock patience for synthetic locks held by the test process. A real owner
  // worker shares its Work with the detached main-audit driver and check controllers, so under load a
  // zero wait turns routine contention into WORK_BUSY errors (observed in landing-lifecycle). Give the
  // worker the same bounded wait as landing-batch-fixture; callers that pass their own env keep control.
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: env === process.env ? { ...env, FORGE_WORK_LOCK_WAIT_MS: '10000' } : env,
  });
  const controller = new AbortController();
  let errors = '';
  child.stderr.on('data', bytes => {
    errors += bytes;
  });
  child.on('error', error => controller.abort(error));
  child.once('exit', (code, signal) =>
    controller.abort(new Error(`worker exited before readiness: ${code ?? signal}; ${errors}`)),
  );
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill(signal);
    await exit;
    assert.doesNotMatch(errors, /(?:Error:|Unhandled|Warning:)/, 'worker had no errors');
  };
  try {
    // Empty-worker tests need idle before submitting work. Recovery tests already
    // have work: observe their durable milestone instead of a transient idle
    // publication that can be overwritten before a loaded observer reads it.
    await until(
      f,
      ready ??
        (() => landingWorkerStates(f.store).find(s => s.worker.pid === child.pid && s.status === 'idle')),
      'child ready',
      controller.signal,
    );
    return { child, stop };
  } catch (error) {
    await stop('SIGKILL');
    throw error;
  }
}

// Hold the real synthetic command until the test acknowledges it. A sleep cannot
// guarantee that a loaded parent observes running before the command completes.
export async function gatedFixture(t) {
  const f = await fixture(t, { remote: false });
  const endpoint = shortSocketPath('gate');
  const connections = new Set();
  let started = false,
    released = false;
  const server = createServer(socket => {
    started = true;
    connections.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
    if (released) socket.end();
  });
  const listening = once(server, 'listening');
  server.listen(endpoint);
  await listening;
  const release = () => {
    released = true;
    for (const socket of connections) socket.end();
  };
  t.after(async () => {
    release();
    await new Promise(resolve => server.close(resolve));
  });
  // Ends the checks that are running now without latching: a check that
  // connects later (the post-accept audit) stays running until release().
  const pass = () => {
    for (const socket of connections) socket.end();
  };
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.store.load().checks[0].id,
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const socket=require('node:net').createConnection(${JSON.stringify(endpoint)});
socket.on('error',()=>process.exit(1));socket.resume();`,
    ],
  });
  return {
    ...f,
    get started() {
      return started;
    },
    get open() {
      return connections.size;
    },
    pass,
    release,
  };
}
