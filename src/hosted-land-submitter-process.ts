// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LAND_CHILD_ENV } from './hosted-land-child-env.js';
import { LAND_INVOKED_ENV } from './land-timing.js';

export const LAND_WAKE_ENV = 'FORGE_LAND_WAKE';
export const LAND_BUDGET_ENV = 'FORGE_LAND_BUDGET_SECONDS';
export const HELD_LAND_WORKER_ENV = 'FORGE_HELD_LAND_WORKER';
export const HELD_LAND_AUTO_ENV = 'FORGE_HELD_LAND_AUTO';

/** Use the same detached submitter for ordinary and measurement-held landings. */
export function spawnLandSubmitter(
  root: string,
  command: Record<string, unknown>,
  base: string,
  budgetSeconds: number,
  wake: boolean,
  held?: { auto: boolean },
) {
  const out = openSync(`${base}.out`, 'w', 0o600);
  try {
    const err = openSync(`${base}.err`, 'w', 0o600);
    try {
      return spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./cli-entry.js', import.meta.url)),
          'agent',
          root,
          'finish',
          JSON.stringify(command),
        ],
        {
          detached: true,
          stdio: ['ignore', out, err],
          env: {
            ...process.env,
            [LAND_CHILD_ENV]: '1',
            [LAND_INVOKED_ENV]: held ? '' : String(performance.timeOrigin),
            [LAND_BUDGET_ENV]: String(budgetSeconds),
            [LAND_WAKE_ENV]: wake ? '1' : '0',
            ...(held ? { [HELD_LAND_WORKER_ENV]: '1', [HELD_LAND_AUTO_ENV]: held.auto ? '1' : '0' } : {}),
          },
        },
      );
    } finally {
      closeSync(err);
    }
  } finally {
    closeSync(out);
  }
}
