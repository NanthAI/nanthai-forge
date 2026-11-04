// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { processStartTime } from './local-process.js';
import { invariant } from './errors.js';

export type ReleaseProcess = { pid: number; startTime: string; executablePath: string };
export function belowRuntime(root: string, path: string) {
  const part = relative(resolve(root), resolve(path));
  return !!part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
const options = {
  encoding: 'utf8' as const,
  timeout: 5000,
  maxBuffer: 16 * 1024 * 1024,
  env: childEnv({ extra: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }),
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
};
/** Arguments are consumed privately; only the Node script path leaves this parser. */
export function releaseProcessRow(row: string): ReleaseProcess | undefined {
  const match =
    /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\/.*?\/node)\s+(\/.*?\/dist\/(?:local-watcher-worker|auto-exchange|presence-worker|post-accept-main|agent-advisory-worker|check-controller-worker|github-auto-push|integration-preview-worker|self-metrics-weekly-worker|cli)\.js)(?:\s|$)/.exec(
      row,
    );
  if (!match || !existsSync(match[4]!)) return;
  return { pid: Number(match[1]), startTime: match[2]!.trim(), executablePath: match[4]! };
}
export function releaseProcesses(): ReleaseProcess[] {
  if (process.platform === 'linux') {
    const result: ReleaseProcess[] = [];
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (!argv[0]?.endsWith('/node') || !argv[1]?.startsWith('/')) continue;
        const startTime = processStartTime(Number(pid));
        if (startTime) result.push({ pid: Number(pid), startTime, executablePath: argv[1] });
      } catch {
        // Processes can exit during enumeration.
      }
    }
    return result;
  }
  invariant(
    process.platform === 'darwin',
    'RELEASE_PROCESS_TABLE_UNAVAILABLE',
    'Process inspection is unavailable.',
  );
  return execFileSync('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'lstart=', '-o', 'command='], options)
    .split('\n')
    .flatMap(row => {
      const value = releaseProcessRow(row);
      return value ? [value] : [];
    });
}
