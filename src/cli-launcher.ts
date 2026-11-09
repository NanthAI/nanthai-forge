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
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { enableCompileCache } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
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
      // Windows PowerShell starts in about 0.2 s on a warm runner and over 1 s when cold.
      timeout: process.platform === 'win32' ? 5000 : 1000,
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
    if (process.platform !== 'win32') return darwinStart(pid, options);
    const command = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      LAUNCHER_WINDOWS_START_SCRIPT.replace('PID', String(pid)),
    ];
    // A cold PowerShell on a loaded runner can outrun one bound: one retry with a longer one.
    let start = '';
    for (const timeout of [10_000, 20_000])
      try {
        start = execFileSync(command, args, { ...options, timeout }).trim();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw error;
      }
    return /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}
/** Byte-identical to WINDOWS_START_SCRIPT in local-process.ts: loads no PowerShell module. */
export const LAUNCHER_WINDOWS_START_SCRIPT =
  '[System.Diagnostics.Process]::GetProcessById(PID).StartTime.ToFileTimeUtc()';
/** Byte-identical to DARWIN_KERNEL_READER in local-process.ts (this file imports only Node). */
export const LAUNCHER_KERNEL_READER =
  'my $m=shift;for my $i(@ARGV){my $k=pack("i4",1,14,$m,$i);my $l=pack("Q",0);' +
  'syscall(202,$k,4,0,$l,0,0)==0 or die;my $n=unpack("Q",$l)+6480;my $b="\\0"x$n;$l=pack("Q",$n);' +
  'syscall(202,$k,4,$b,$l,0,0)==0 or die;$n=unpack("Q",$l);$n%648==0 or die;' +
  'for(my $o=0;$o<$n;$o+=648){my $s=unpack("q",substr($b,$o,8));$s>0 or die;' +
  'printf "%d %d %d\\n",unpack("i",substr($b,$o+40,4)),$s,unpack("C",substr($b,$o+36,1))}}';
let psRefused = false;
/** ps lstart; inside a macOS sandbox that refuses setuid ps, the same kernel record via sysctl. */
function darwinStart(pid: number, options: ExecFileSyncOptionsWithStringEncoding): string | undefined {
  if (!psRefused)
    try {
      return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options).trim();
    } catch (error) {
      const { code, status } = error as { code?: unknown; status?: unknown };
      if (!(status == null && (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT'))) throw error;
      psRefused = true;
    }
  const row = /^(\d+) (\d+) \d+$/.exec(
    execFileSync('/usr/bin/perl', ['-e', LAUNCHER_KERNEL_READER, '1', String(pid)], options).trim(),
  );
  if (!row || Number(row[1]) !== pid) return undefined;
  const at = new Date(Number(row[2]) * 1000),
    two = (value: number) => String(value).padStart(2, '0');
  const day = 'SunMonTueWedThuFriSat'.slice(at.getUTCDay() * 3, at.getUTCDay() * 3 + 3),
    month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.slice(at.getUTCMonth() * 3, at.getUTCMonth() * 3 + 3);
  return `${day} ${month} ${String(at.getUTCDate()).padStart(2, ' ')} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
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
    // The CLI is imported into this process: it reads its own start time here, never by shelling out.
    (globalThis as Record<symbol, unknown>)[Symbol.for('forge.ownProcessStart')] = identity;
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
export function resolveCliPointer(installation: string, pointer: 'current' | 'manager' | 'previous'): string {
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
/** Node's on-disk compile cache, one owner-only folder per build (about 8 MB): later commands
 * skip recompiling the unchanged module graph. Node keys and checks entries by source hash, so
 * a changed file just recompiles. Folders of builds that no longer exist go when a new one is
 * made, so updates never accumulate them. A cache only: any failure runs uncached. */
export function enableCliCompileCache(installation: string, build: string) {
  try {
    const root = join(installation, 'compile-cache'),
      name = basename(build),
      own = join(root, name);
    if (!existsSync(own)) {
      mkdirSync(own, { recursive: true, mode: 0o700 });
      for (const other of readdirSync(root))
        if (other !== name && !existsSync(join(dirname(build), other)))
          rmSync(join(root, other), { recursive: true, force: true });
    }
    enableCompileCache(own);
  } catch {
    /* Uncached. */
  }
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
  enableCliCompileCache(installation, manager);
  await import(/* @vite-ignore */ pathToFileURL(join(manager, 'dist', 'cli-entry.js')).href);
}
// The filename check also prevents this entry from running inside the bundled edit hook.
if (
  basename(fileURLToPath(import.meta.url)) === 'launcher.mjs' &&
  process.argv[1] &&
  // Node names the main module by its real path; a symlinked install must compare real paths.
  existsSync(process.argv[1]) &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
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
