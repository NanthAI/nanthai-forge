// SPDX-License-Identifier: Apache-2.0
// Standalone bootstrap: copied to INSTALLATION/launcher.mjs. Only Node imports;
// its code and lock/lease protocol must not depend on the selected CLI build.
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Identity = { pid: number; startTime: string };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const recovery = (installation: string) => `nforge update --directory ${quote(installation)}`;
const failure = (code: string, message: string) =>
  Object.assign(new Error(message), { name: 'ForgeError', code });
function kernelStart(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const row = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return row.slice(row.lastIndexOf(')') + 2).split(' ')[19];
    }
    const options = {
      encoding: 'utf8' as const,
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
      env: {
        LC_ALL: 'C',
        LANG: 'C',
        TZ: 'UTC',
        ...(process.platform === 'win32'
          ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
          : {}),
      },
    };
    return process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
          options,
        ).trim()
      : execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options).trim();
  } catch {
    return undefined;
  }
}
let identity: Identity | undefined;
export function cliProcessIdentity(): Identity {
  if (!identity) {
    const startTime = kernelStart(process.pid);
    if (!startTime)
      throw failure(
        'CLI_PROCESS_IDENTITY_UNAVAILABLE',
        'Cannot identify this CLI process; retry the original command.',
      );
    identity = { pid: process.pid, startTime };
  }
  return identity;
}
function dead(owner: { pid?: number; host?: string; startTime?: string }) {
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return false;
  try {
    process.kill(owner.pid!, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const observed = kernelStart(owner.pid!);
  return !!owner.startTime && !!observed && observed !== owner.startTime;
}
/** How long a user command, the launcher or the updater waits for a live runtime-lock holder. */
export const CLI_RUNTIME_WAIT_MS = 30_000;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Resolve `current`/`manager` to its build. Replacing a symlink by rename is atomic for the link,
 * but macOS (APFS) lookups racing that rename can fail with EINVAL for an instant, so a
 * reader retries briefly instead of failing a command at the moment of the switch. */
export function resolveCliPointer(installation: string, pointer: 'current' | 'manager'): string {
  const path = join(installation, pointer);
  for (let attempt = 0; ; attempt++) {
    try {
      return realpathSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 200 || code !== 'EINVAL') throw error;
      sleepSync(attempt < 20 ? 1 : 5);
    }
  }
}
/** Publish complete lock-owner bytes atomically; a killed claimant never leaves an empty lock.
 * The lock is held for milliseconds, so contention (parallel commands, an update publishing) is
 * absorbed by a bounded backoff wait instead of refusing. Hooks keep waitMs = 0 and fail open. */
export function withCliRuntimeLock<T>(installation: string, run: () => T, waitMs = 0): T {
  mkdirSync(installation, { recursive: true, mode: 0o700 });
  const path = join(installation, 'runtime.lock'),
    pending = `${path}-${process.pid}-${randomUUID()}.pending`;
  const owner = JSON.stringify({ ...cliProcessIdentity(), host: hostname(), operation: 'CLI runtime' });
  const fd = openSync(pending, 'wx', 0o600);
  try {
    writeFileSync(fd, owner);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let acquired = false;
  try {
    const deadline = Date.now() + waitMs;
    let delay = 10;
    for (let attempt = 0; !acquired; attempt++) {
      if (attempt >= 2) {
        if (Date.now() >= deadline) break;
        sleepSync(Math.min(delay, Math.max(1, deadline - Date.now())));
        delay = Math.min(delay * 2, 200);
      }
      try {
        linkSync(pending, path);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // The lock is synchronous and not re-entrant: waiting on our own hold could only time out.
        if (attempt === 0) {
          let holder: { pid?: number; host?: string; startTime?: string } = {};
          try {
            holder = JSON.parse(readFileSync(path, 'utf8'));
          } catch {
            /* Unreadable owner: the normal wait applies. */
          }
          if (
            holder.pid === process.pid &&
            holder.host === hostname() &&
            holder.startTime === cliProcessIdentity().startTime
          )
            throw failure('CLI_RUNTIME_LOCK_REENTERED', 'This CLI process already holds the runtime lock.');
        }
        const fence = `${path}-recovery`;
        try {
          mkdirSync(fence, { mode: 0o700 });
          try {
            const before = readFileSync(path, 'utf8');
            if (dead(JSON.parse(before)) && readFileSync(path, 'utf8') === before) rmSync(path);
          } finally {
            rmSync(fence, { recursive: true, force: true });
          }
        } catch {
          /* A live/unknown holder or another recovery owns this lock. */
        }
      }
    }
    if (!acquired)
      throw failure(
        'CLI_RUNTIME_BUSY',
        `Another CLI runtime operation is finishing. Next: ${recovery(installation)}`,
      );
    return run();
  } finally {
    if (acquired) rmSync(path, { force: true });
    rmSync(pending, { force: true });
  }
}
export function claimCliRuntime(installation: string, root: string, waitMs = 0) {
  const value = cliProcessIdentity(),
    users = join(root, '.users'),
    file = join(users, String(value.pid));
  try {
    if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) === JSON.stringify(value)) return;
  } catch {
    /* Claim under the fence below. */
  }
  withCliRuntimeLock(
    installation,
    () => {
      if (!existsSync(root))
        throw failure('CLI_RUNTIME_RETIRED', `CLI runtime was retired. Next: ${recovery(installation)}`);
      mkdirSync(users, { recursive: true, mode: 0o700 });
      const fd = openSync(file, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    waitMs,
  );
}
async function launch() {
  try {
    process.cwd();
  } catch {
    throw failure(
      'CWD_UNAVAILABLE',
      'The current working directory was removed or is unavailable. Run cd /, then cd /absolute/path/to/your/Forge/checkout and retry the original command.',
    );
  }
  const installation = dirname(fileURLToPath(import.meta.url));
  const manager = withCliRuntimeLock(
    installation,
    () => {
      const selected = resolveCliPointer(installation, 'manager');
      const value = cliProcessIdentity(),
        users = join(selected, '.users');
      mkdirSync(users, { recursive: true, mode: 0o700 });
      const fd = openSync(join(users, String(value.pid)), 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return selected;
    },
    CLI_RUNTIME_WAIT_MS,
  );
  await import(/* @vite-ignore */ pathToFileURL(join(manager, 'dist', 'cli-entry.js')).href);
}
// The filename check also prevents this entry from running inside the bundled edit hook.
if (
  basename(fileURLToPath(import.meta.url)) === 'launcher.mjs' &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await launch();
  } catch (error) {
    const value = error as Error & { code?: string };
    const next = recovery(dirname(fileURLToPath(import.meta.url)));
    const message =
      value.message.includes('Next:') || value.code === 'CWD_UNAVAILABLE'
        ? value.message
        : `${value.message} Next: ${next}`;
    process.stderr.write(
      `${JSON.stringify({ error: { code: value.code ?? 'CLI_UPDATE_REQUIRED', message } })}\n`,
    );
    process.exitCode = 1;
  }
}
