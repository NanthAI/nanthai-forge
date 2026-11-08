// SPDX-License-Identifier: Apache-2.0
// Child-process helper of the zoo run (Issue 85d26a8b): timed, bounded, last JSON line parsed.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 40 * 60_000;

/** Runs a command; resolves { code, stdout, stderr, seconds, json } (json = last JSON line). */
export function exec(cmd, args, { cwd, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        seconds: (performance.now() - started) / 1000,
        json: lastJson(stdout) ?? lastJson(stderr),
      });
    });
  });
}

export function lastJson(text) {
  const lines = String(text).trim().split('\n').reverse();
  for (const line of lines)
    if (line.startsWith('{'))
      try {
        return JSON.parse(line);
      } catch {}
  return null;
}
