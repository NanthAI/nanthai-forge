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
function inspect(pid: number): { startTime: string; zombie: boolean } | undefined {
  if (pid === process.pid && ownStartTime) return { startTime: ownStartTime, zombie: false };
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { startTime: fields[19]!, zombie: fields[0] === 'Z' };
    }
    if (process.platform === 'win32') {
      const startTime = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        options,
      ).trim();
      return startTime ? { startTime, zombie: false } : undefined;
    }
    const value = execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='],
      options,
    ).trim();
    const last = value.lastIndexOf(' ');
    return last > 0
      ? { startTime: value.slice(0, last).trim(), zombie: value.slice(last + 1).startsWith('Z') }
      : undefined;
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
    throw new ForgeError('PROCESS_IDENTITY_UNAVAILABLE', 'Could not record the local process start time.');
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
  const observed = new Map<number, { startTime: string; zombie: boolean }>();
  try {
    const rows = execFileSync(
      '/bin/ps',
      [
        '-p',
        [...new Set(identities.map(item => item.pid))].join(','),
        '-o',
        'pid=',
        '-o',
        'lstart=',
        '-o',
        'stat=',
      ],
      options,
    );
    for (const row of rows.split('\n')) {
      const match = /^\s*(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(row);
      if (match)
        observed.set(Number(match[1]), { startTime: match[2]!.trim(), zombie: match[3]!.startsWith('Z') });
    }
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
    const groups = execFileSync('/bin/ps', ['-ax', '-o', 'pgid=', '-o', 'stat='], options);
    return groups.split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && state !== undefined && !state.startsWith('Z');
    });
  } catch {
    return true;
  }
}
