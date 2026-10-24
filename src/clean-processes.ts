// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync, statSync } from 'node:fs';
/** Observe local working directories once per cleanup. Unknown coverage retains copies. */
export function workingProcesses(): { paths: string[]; unknown: boolean } {
  try {
    if (process.platform === 'linux') {
      const paths: string[] = [];
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (statSync(`/proc/${entry}`).uid !== process.getuid?.()) continue;
          paths.push(readlinkSync(`/proc/${entry}/cwd`));
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
            return { paths, unknown: true };
        }
      }
      return { paths, unknown: false };
    }
    if (process.platform === 'darwin') {
      const output = execFileSync(
        '/usr/sbin/lsof',
        ['-a', '-u', String(process.getuid!()), '-d', 'cwd', '-Fn'],
        {
          env: childEnv(),
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      return {
        paths: output
          .split('\n')
          .filter(line => line.startsWith('n'))
          .map(line => line.slice(1)),
        unknown: false,
      };
    }
  } catch {
    /* Unknown process coverage is reported rather than guessed. */
  }
  return { paths: [], unknown: true };
}
export function processBlocker(path: string, observed: ReturnType<typeof workingProcesses>) {
  if (observed.paths.some(cwd => cwd === path || cwd.startsWith(path + '/')))
    return 'A local process is working in this directory.';
  return observed.unknown ? 'Local process coverage is unavailable.' : undefined;
}
