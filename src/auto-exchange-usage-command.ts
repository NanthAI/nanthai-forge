// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { UsageAdapter } from './auto-exchange-spend.js';

export const USAGE_COMMAND_TIMEOUT_MS = 5_000;
export const USAGE_COMMAND_MAX_BYTES = 16_384;
export const USAGE_CACHE_MS = 60_000;

/** Owner-local executable only. No shell, inherited secrets, account discovery,
 * or provider output in errors. Private directories are not an OS sandbox. */
export function commandUsage(command: string | undefined): UsageAdapter {
  return async context => {
    if (!command) return undefined;
    if (!isAbsolute(command)) throw new Error('Usage command must be absolute.');
    const directory = await mkdtemp(join(tmpdir(), 'forge-usage-'));
    try {
      const home = join(directory, 'home'),
        temporary = join(directory, 'tmp');
      await mkdir(home, { mode: 0o700 });
      await mkdir(temporary, { mode: 0o700 });
      return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(command, [context.projectId, context.deployment], {
          shell: false,
          detached: process.platform !== 'win32',
          cwd: directory,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOME: home,
            XDG_CONFIG_HOME: home,
            XDG_CACHE_HOME: home,
            XDG_DATA_HOME: home,
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
          },
        });
        let bytes = 0,
          settled = false;
        const output: Buffer[] = [];
        const stop = (failed: boolean, value?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Also close descendants that retain pipes after their parent exits.
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // The command may already have exited.
          }
          child.stdout.destroy();
          child.stderr.destroy();
          if (failed) reject(new Error('Usage command unavailable.'));
          else resolve(value);
        };
        const timer = setTimeout(() => stop(true), USAGE_COMMAND_TIMEOUT_MS);
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > USAGE_COMMAND_MAX_BYTES) stop(true);
            else if (stream === child.stdout) output.push(chunk);
          });
        child.on('error', () => stop(true));
        child.on('close', code => {
          if (code !== 0) return stop(true);
          try {
            stop(false, JSON.parse(Buffer.concat(output).toString('utf8')));
          } catch {
            stop(true);
          }
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
