// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { readSource } from './files.js';
import type { Check, CheckRun } from './work-types.js';

const coverage =
  'Native command resource observation, not an aggregate concurrent-process peak, complete input boundary, sandbox or provider billing measurement. Code under this OS account can alter the report.';
export function resourceCommand(check: Check, directory: string) {
  if (!check.measureResources || !existsSync('/usr/bin/time')) return undefined;
  let producer: string, args: string[];
  if (process.platform === 'darwin') {
    producer = 'BSD /usr/bin/time';
    args = ['-lp'];
  } else if (process.platform === 'linux') {
    const version = spawnSync('/usr/bin/time', ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 16384,
    });
    if (version.status !== 0 || !version.stdout?.includes('GNU')) return undefined;
    producer = version.stdout.trim().split('\n')[0]!;
    args = ['-f', 'real %e\nuser %U\nsys %S\n%M maximum resident set size'];
  } else return undefined;
  closeSync(openSync(join(directory, 'resources.txt'), 'wx', 0o600));
  return {
    executable: '/usr/bin/time',
    args: [...args, '-o', join(directory, 'resources.txt'), '--', check.executable, ...check.args],
    producer,
  };
}
export function parseResources(
  report: string,
  producer: string,
  platform: string,
): CheckRun['resourceUsage'] {
  const number = (pattern: RegExp) => {
    const matches = [...report.matchAll(pattern)];
    return matches.length === 1 ? Number(matches[0]![1]) : NaN;
  };
  const realSeconds = number(/^real ([0-9]+(?:\.[0-9]+)?)\s*$/gm);
  const userSeconds = number(/^user ([0-9]+(?:\.[0-9]+)?)\s*$/gm);
  const systemSeconds = number(/^sys ([0-9]+(?:\.[0-9]+)?)\s*$/gm);
  const peakRssBytes =
    number(/^\s*([0-9]+)\s+maximum resident set size\s*$/gm) * (platform === 'linux' ? 1024 : 1);
  if (
    ![realSeconds, userSeconds, systemSeconds, peakRssBytes].every(Number.isFinite) ||
    !Number.isSafeInteger(peakRssBytes)
  )
    return {
      status: 'unavailable',
      producer,
      details: 'Native resource report is incomplete or invalid. ' + coverage,
    };
  return {
    status: 'measured',
    producer,
    realSeconds,
    userSeconds,
    systemSeconds,
    peakRssBytes,
    report,
    details: coverage,
  };
}
export function readResources(directory: string, producer?: string): CheckRun['resourceUsage'] {
  try {
    if (producer) {
      const report = readSource(directory, 'resources.txt', 65536);
      if (report) return parseResources(report.toString('utf8'), producer, process.platform);
    }
  } catch {
    /* Missing/changed reports never change the selected command's outcome. */
  }
  return {
    status: 'unavailable',
    ...(producer ? { producer } : {}),
    details: 'No complete supported native resource report was available. ' + coverage,
  };
}
