// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { childEnv } from '../scripts/child-env.mjs';
import { invariant } from './errors.js';
/** Legacy runtimes predate leases. Consume argv privately; expose only script paths. */
export type CliRuntimeUser = { pid: number; path: string };
export function cliRuntimePaths(): CliRuntimeUser[] {
  if (process.platform === 'linux')
    return readdirSync('/proc')
      .filter(name => /^\d+$/.test(name))
      .flatMap(pid => {
        try {
          const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          return (args[0] === 'node' || args[0]?.endsWith('/node')) && args[1]?.startsWith('/')
            ? [{ pid: Number(pid), path: args[1] }]
            : [];
        } catch {
          return [];
        }
      });
  invariant(
    process.platform === 'darwin',
    'CLI_PROCESS_TABLE_UNAVAILABLE',
    'Legacy runtime inspection is unavailable; keep older builds.',
  );
  return execFileSync('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'comm=', '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .flatMap(row => {
      const match = /^\s*(\d+)\s+\S*\/?node\s+\S*\/?node\s+(\/.*?\/dist\/[\w-]+\.js)(?:\s|$)/.exec(row);
      return match ? [{ pid: Number(match[1]), path: match[2]! }] : [];
    });
}
