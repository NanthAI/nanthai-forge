// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ForgeError } from './errors.js';

let ownStartTime: string | undefined;
const options: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf8',
  timeout: 5000,
  env: childEnv({ extra: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }),
  stdio: ['ignore', 'pipe', 'ignore'],
};
type Observation = { startTime: string; zombie: boolean };
/** ps `lstart` text (C locale, UTC) for kernel seconds, so identities recorded inside and
 * outside a sandbox compare equal and records written by older builds stay valid. */
export function lstartText(seconds: number): string {
  const at = new Date(seconds * 1000),
    two = (value: number) => String(value).padStart(2, '0');
  const day = 'SunMonTueWedThuFriSat'.slice(at.getUTCDay() * 3, at.getUTCDay() * 3 + 3),
    month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.slice(at.getUTCMonth() * 3, at.getUTCMonth() * 3 + 3);
  return `${day} ${month} ${String(at.getUTCDate()).padStart(2, ' ')} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
}
/** sysctl(CTL_KERN, KERN_PROC, mode, id) via perl's syscall(): the same kernel record setuid
 * /bin/ps reads, without setuid exec. Prints "pid startSeconds pStat" per process; any kernel
 * error or unexpected struct size exits non-zero so callers stay conservative.
 * Kept byte-identical in cli-launcher.ts (standalone); tests/sandbox-process-identity pins both. */
export const DARWIN_KERNEL_READER =
  'my $m=shift;for my $i(@ARGV){my $k=pack("i4",1,14,$m,$i);my $l=pack("Q",0);' +
  'syscall(202,$k,4,0,$l,0,0)==0 or die;my $n=unpack("Q",$l)+6480;my $b="\\0"x$n;$l=pack("Q",$n);' +
  'syscall(202,$k,4,$b,$l,0,0)==0 or die;$n=unpack("Q",$l);$n%648==0 or die;' +
  'for(my $o=0;$o<$n;$o+=648){my $s=unpack("q",substr($b,$o,8));$s>0 or die;' +
  'printf "%d %d %d\\n",unpack("i",substr($b,$o+40,4)),$s,unpack("C",substr($b,$o+36,1))}}';
/** Windows PowerShell 5.1 ships with every supported Windows. Absolute path: no PATH lookup.
 * The .NET call loads no module: `Get-Process` autoloads one and hangs when PSModulePath is
 * absent, which the minimal child environment omits. Same FILETIME value as Get-Process.
 * Kept byte-identical in cli-launcher.ts (standalone); tests/local-process-snapshot pins both. */
export const WINDOWS_START_SCRIPT =
  '[System.Diagnostics.Process]::GetProcessById(PID).StartTime.ToFileTimeUtc()';
export const windowsPowerShell = (root = process.env.SystemRoot || 'C:\\Windows') =>
  `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const windowsStartArgs = (pid: number) => [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  WINDOWS_START_SCRIPT.replace('PID', String(pid)),
];
const SZOMB = 5;
function kernelRows(mode: 1 | 2, ids: number[]): { pid: number; observation: Observation }[] {
  const rows = execFileSync(
    '/usr/bin/perl',
    ['-e', DARWIN_KERNEL_READER, String(mode), ...ids.map(String)],
    options,
  );
  return rows.split('\n').flatMap(row => {
    const match = /^(\d+) (\d+) (\d+)$/.exec(row);
    return match
      ? [
          {
            pid: Number(match[1]),
            observation: { startTime: lstartText(Number(match[2])), zombie: Number(match[3]) === SZOMB },
          },
        ]
      : [];
  });
}
// macOS sandboxes (sandbox-exec under Codex, Claude Code sandbox mode, other harnesses) refuse
// to exec setuid binaries such as /bin/ps. Once ps is refused, read the kernel directly.
let psRefused = false;
function observeDarwin<T>(ps: () => T, kernel: () => T): T {
  if (!psRefused)
    try {
      return ps();
    } catch (error) {
      const { code, status } = error as { code?: unknown; status?: unknown };
      if (!(status == null && (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT'))) throw error;
      psRefused = true;
    }
  return kernel();
}
function inspect(pid: number): { startTime: string; zombie: boolean } | undefined {
  if (pid === process.pid && ownStartTime) return { startTime: ownStartTime, zombie: false };
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { startTime: fields[19]!, zombie: fields[0] === 'Z' };
    }
    if (process.platform === 'win32') {
      const startTime = execFileSync(windowsPowerShell(), windowsStartArgs(pid), options).trim();
      return /^\d+$/.test(startTime) ? { startTime, zombie: false } : undefined;
    }
    return observeDarwin<Observation | undefined>(
      () => {
        const value = execFileSync(
          '/bin/ps',
          ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='],
          options,
        ).trim();
        const last = value.lastIndexOf(' ');
        return last > 0
          ? { startTime: value.slice(0, last).trim(), zombie: value.slice(last + 1).startsWith('Z') }
          : undefined;
      },
      () => kernelRows(1, [pid]).find(row => row.pid === pid)?.observation,
    );
  } catch {
    return undefined;
  }
}
/** Kernel start identity, independent of PID reuse. Unknown observations stay live. */
export function processStartTime(pid: number): string | undefined {
  return inspect(pid)?.startTime;
}
export function processIdentity(pid = process.pid) {
  const startTime = processStartTime(pid);
  if (!startTime)
    throw new ForgeError(
      'PROCESS_IDENTITY_UNAVAILABLE',
      process.platform === 'darwin'
        ? 'Could not record the local process start time: /bin/ps and /usr/bin/perl (kernel reader) were both unavailable. In a sandbox, allow exec of /usr/bin/perl and sysctl-read of kern.proc.'
        : 'Could not record the local process start time.',
    );
  if (pid === process.pid) ownStartTime = startTime;
  return { pid, startTime };
}
export function processAlive(identity: { pid: number; startTime?: string | undefined }): boolean {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  const current = inspect(identity.pid);
  if (current?.zombie) return false;
  if (!identity.startTime) return true; // Legacy runs have no start identity; never guess PID reuse.
  return current === undefined || current.startTime === identity.startTime;
}
/** Fresh kernel snapshot for one queue scan, avoiding one ps process per ticket.
 * Missing/failed observations remain conservative; only an observed different
 * start identity, zombie, or ESRCH permits reclaiming a ticket. */
export function processesAlive(identities: { pid: number; startTime?: string | undefined }[]): boolean[] {
  if (process.platform === 'linux' || process.platform === 'win32' || identities.length < 2)
    return identities.map(processAlive);
  const observed = new Map<number, Observation>();
  const pids = [...new Set(identities.map(item => item.pid))];
  try {
    observeDarwin(
      () => {
        const rows = execFileSync(
          '/bin/ps',
          ['-p', pids.join(','), '-o', 'pid=', '-o', 'lstart=', '-o', 'stat='],
          options,
        );
        for (const row of rows.split('\n')) {
          const match = /^\s*(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(row);
          if (match)
            observed.set(Number(match[1]), {
              startTime: match[2]!.trim(),
              zombie: match[3]!.startsWith('Z'),
            });
        }
      },
      () => {
        for (const row of kernelRows(1, pids)) observed.set(row.pid, row.observation);
      },
    );
  } catch {
    // Unknown start identities never establish that a live PID can be reclaimed.
  }
  return identities.map(identity => {
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    }
    const current = observed.get(identity.pid);
    return !current?.zombie && (!identity.startTime || !current || current.startTime === identity.startTime);
  });
}
export function processGroupAlive(pid?: number, startTime?: string): boolean {
  if (!pid) return false;
  const current = inspect(pid);
  if (startTime && current && current.startTime !== startTime) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (process.platform === 'win32') return !current?.zombie;
  if (current && !current.zombie) return true;
  // A zombie group leader is not executing, but its live descendants still hold capacity.
  try {
    return observeDarwin(
      () =>
        execFileSync('/bin/ps', ['-ax', '-o', 'pgid=', '-o', 'stat='], options)
          .split('\n')
          .some(line => {
            const [group, state] = line.trim().split(/\s+/);
            return Number(group) === pid && state !== undefined && !state.startsWith('Z');
          }),
      () => kernelRows(2, [pid]).some(row => !row.observation.zombie),
    );
  } catch {
    return true;
  }
}

// Cache only positive identity observations. ESRCH is checked every time; stale
// positives may delay recovery briefly but never reclaim a live/reused process.
const liveObservations = new Map<string, number>();
export function processesAliveCached(identities: { pid: number; startTime?: string | undefined }[]) {
  const now = performance.now();
  for (const [key, until] of liveObservations) if (until <= now) liveObservations.delete(key);
  const pending: number[] = [];
  const alive = identities.map((identity, index) => {
    const key = `${identity.pid}.${identity.startTime}`;
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        liveObservations.delete(key);
        return false;
      }
    }
    if (!liveObservations.has(key)) pending.push(index);
    return true;
  });
  const sampled = processesAlive(pending.map(index => identities[index]!));
  sampled.forEach((value, offset) => {
    const index = pending[offset]!,
      identity = identities[index]!;
    alive[index] = value;
    if (value) liveObservations.set(`${identity.pid}.${identity.startTime}`, performance.now() + 250);
  });
  return alive;
}
export const processAliveCached = (identity: { pid: number; startTime?: string | undefined }) =>
  processesAliveCached([identity])[0]!;
