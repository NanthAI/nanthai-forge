// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { watchLocal } from './local-watcher.js';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
export function cliLandingCommand(args: string[]) {
  return (
    args[0] === 'land' ||
    (['agent', 'x'].includes(args[0] ?? '') && ['land', 'finish'].includes(args[2] ?? ''))
  );
}
/** Local hints plus a fallback only while a measurement hold is active; no server polling. */
export async function waitForCliMeasurement(installation: string, signal?: AbortSignal) {
  const hold = join(installation, '.freeze');
  if (!existsSync(hold)) return;
  process.stderr.write(
    `Forge CLI landing waits for measurement hold ${hold}; it resumes when the hold is removed.\n`,
  );
  await new Promise<void>((done, reject) => {
    let finished = false,
      warned = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearInterval(fallback);
      void watcher.close();
      process.removeListener('SIGINT', cancelled);
      process.removeListener('SIGTERM', cancelled);
      signal?.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else done();
    };
    const cancelled = () =>
      finish(
        new ForgeError(
          'CLI_MEASUREMENT_WAIT_CANCELLED',
          'Stopped waiting for the measurement hold; retry the original command to resume.',
        ),
      );
    const recheck = () => {
      if (finished) return;
      if (!existsSync(hold)) finish();
      else if (!warned && watcher.health.status === 'degraded') {
        warned = true;
        process.stderr.write(
          `${JSON.stringify({
            category: 'ENVIRONMENT',
            code: watcher.health.code,
            message: 'Filesystem events are degraded (fseventsd on macOS); hold removal is checked locally.',
            next: 'nforge doctor .',
          })}\n`,
        );
      }
    };
    const watcher = watchLocal(installation, { onReady: () => queueMicrotask(recheck) }, recheck);
    const fallback = setInterval(recheck, 1000);
    process.once('SIGINT', cancelled);
    process.once('SIGTERM', cancelled);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    else recheck();
  });
}
