// SPDX-License-Identifier: Apache-2.0
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
export function cliLandingCommand(args: string[]) {
  return (
    args[0] === 'land' ||
    (['agent', 'x'].includes(args[0] ?? '') && ['land', 'finish'].includes(args[2] ?? ''))
  );
}
/** Watch the local hold before the single freshness read; no timers or server polling. */
export async function waitForCliMeasurement(installation: string, signal?: AbortSignal) {
  const hold = join(installation, '.freeze');
  if (!existsSync(hold)) return;
  process.stderr.write(
    `Forge CLI landing waits for measurement hold ${hold}; it resumes when the hold is removed.\n`,
  );
  await new Promise<void>((done, reject) => {
    const finish = (error?: Error) => {
      watcher.close();
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
    const watcher = watch(installation, () => {
      if (!existsSync(hold)) finish();
    });
    watcher.once('error', error => finish(error));
    process.once('SIGINT', cancelled);
    process.once('SIGTERM', cancelled);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    else if (!existsSync(hold)) finish();
  });
}
