// SPDX-License-Identifier: Apache-2.0
// Child-process helper of the zoo run (Issue 85d26a8b): timed, bounded, last JSON line parsed.
import { spawn } from 'node:child_process';
import { statfsSync } from 'node:fs';

// A landing command waits while a measurement hold is on (a bench batch can hold for over an hour),
// so the bound is generous; a stuck process is still ended.
const TIMEOUT_MS = 120 * 60_000;

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

/** Free GiB on the volume holding `path`. */
export const freeGiB = (path = '/') => {
  const s = statfsSync(path);
  return (s.bavail * s.bsize) / 2 ** 30;
};

/** Waits (polling) until `minGiB` are free, so a run never starts a repository below the disk reserve;
 * throws after `timeoutMs` (the machine is shared: other work may hold the space for a while). */
export async function waitForDisk(
  minGiB,
  { path = '/', timeoutMs = 30 * 60_000, pollMs = 30_000, free = freeGiB } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (free(path) < minGiB) {
    if (Date.now() > deadline)
      throw Error(`ZOO_DISK_RESERVE: under ${minGiB} GiB free for ${Math.round(timeoutMs / 60_000)} min`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
