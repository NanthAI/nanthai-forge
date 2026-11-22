// SPDX-License-Identifier: Apache-2.0
import { execFileSync, type ChildProcess } from 'node:child_process';

export const windowsTaskkill = (root = process.env.SystemRoot || 'C:\\Windows') =>
  `${root}\\System32\\taskkill.exe`;
/** Stop a spawned command and everything it started. On Linux and macOS the command must be spawned
 * `detached`, so its process group is signalled. Windows has no process groups: while the command
 * runs, `taskkill /T /F` ends it with its whole descendant tree. Once it has exited Windows may reuse
 * its PID, so nothing is signalled and a descendant it left running is not found (a documented limit,
 * docs/operations/self-hosted-runner.md#windows). */
export function stopProcessTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>,
  signal: NodeJS.Signals = 'SIGKILL',
  platform: NodeJS.Platform = process.platform,
) {
  const pid = child.pid;
  if (!pid) return;
  if (platform !== 'win32') {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync(windowsTaskkill(), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    });
  } catch {
    child.kill(signal);
  }
}
/** After the command exits: anything still in its process group is stopped (TERM, then KILL after
 * 2 s), so no child it started keeps running outside heavy. Unix only; a no-op with nothing left. */
export async function stopLeftovers(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>) {
  const pid = child.pid;
  if (!pid || process.platform === 'win32') return;
  const left = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  if (!left()) return;
  stopProcessTree(child, 'SIGTERM');
  for (let waited = 0; waited < 2000 && left(); waited += 100)
    await new Promise(done => setTimeout(done, 100));
  if (left()) stopProcessTree(child, 'SIGKILL');
}
