// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn } from 'node:child_process';

const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const grouped = process.platform !== 'win32';
const captureLimit = 1024 * 1024;

/** Terminate the process group on a deadline or when preflight is interrupted, and wait for close. */
export function packageProbeProcesses(timeout = 15_000) {
  const children = new Set();
  let stopped = false;
  function kill(child) {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
  function stop() {
    stopped = true;
    for (const child of children) kill(child);
  }
  for (const signal of signals) process.once(signal, stop);
  return {
    run(args, { cwd, env } = {}) {
      if (stopped) return Promise.reject(new Error('Package probes interrupted.'));
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: grouped,
        });
        children.add(child);
        let failure;
        let bytes = 0;
        const output = { stdout: [], stderr: [] };
        for (const stream of ['stdout', 'stderr']) {
          child[stream].on('data', chunk => {
            bytes += chunk.length;
            if (bytes <= captureLimit) output[stream].push(chunk);
            else {
              failure = new Error('Package probe output exceeded its capture budget.');
              kill(child);
            }
          });
        }
        const timer = setTimeout(() => {
          failure = new Error('Package probe timed out.');
          kill(child);
        }, timeout);
        child.once('error', error => {
          failure = error;
        });
        child.once('close', code => {
          clearTimeout(timer);
          children.delete(child);
          if (failure || code !== 0) reject(failure ?? new Error('Package probe did not finish.'));
          else
            resolve({
              stdout: Buffer.concat(output.stdout).toString('utf8'),
              stderr: Buffer.concat(output.stderr).toString('utf8'),
            });
        });
      });
    },
    dispose() {
      stop();
      for (const signal of signals) process.off(signal, stop);
    },
  };
}
