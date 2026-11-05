// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIME = '/usr/bin/time';

/** BSD (`-l`, bytes) and GNU (`-v`, kilobytes) report the largest resident set of any process
 * the command waited for. Anything else, or a `time` that rejects the flag, is "unmeasured". */
export function parsePeakRssMb(text: string): number | null {
  const bsd = /^\s*(\d+)\s+maximum resident set size/im.exec(text);
  if (bsd) return Math.ceil(Number(bsd[1]) / 2 ** 20);
  const gnu = /Maximum resident set size \(kbytes\):\s*(\d+)/i.exec(text);
  return gnu ? Math.ceil(Number(gnu[1]) / 1024) : null;
}
const flag = () => (process.platform === 'darwin' ? '-l' : process.platform === 'linux' ? '-v' : null);

/** Runs a command and reports its status and peak resident memory when this platform can say.
 * Wrapping never changes the command's exit status; a missing or unusable `time` just runs it. */
export function spawnMeasured(command: string, args: string[], options: SpawnSyncOptions) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-preflight-rss-'));
  try {
    const mode = flag();
    const out = join(directory, 'time.txt');
    if (mode && existsSync(TIME)) {
      const probe = spawnSync(TIME, [mode, '-o', join(directory, 'probe.txt'), process.execPath, '-e', ''], {
        stdio: 'ignore',
      });
      if (probe.status === 0) {
        const run = spawnSync(TIME, [mode, '-o', out, command, ...args], options);
        let peakRssMb: number | null = null;
        try {
          peakRssMb = parsePeakRssMb(readFileSync(out, 'utf8'));
        } catch {
          /* A killed run leaves no report. */
        }
        return { status: run.status, peakRssMb };
      }
    }
    return {
      status: spawnSync(command, args, options).status,
      peakRssMb: null as number | null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
