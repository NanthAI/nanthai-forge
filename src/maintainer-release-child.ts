// SPDX-License-Identifier: Apache-2.0
import { workerPath } from './worker-install.js';
import { childEnv } from '../scripts/child-env.mjs';
import { ownerEnvNames } from './worker-environment.js';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { releaseJson, releaseSave } from './maintainer-release-files.js';
import { releaseReceiptSchema, type ReleaseJournal, type ReleaseStage } from './maintainer-release-schema.js';
import { processAlive } from './local-process.js';

/** The stage process writes its own terminal receipt, even if its caller disappears. */
export function releaseChild(journal: ReleaseJournal, name: ReleaseStage, directory: string) {
  const stage = journal.stages.find(stage => stage.name === name)!;
  const attempt = stage.attempts.at(-1)!;
  const receiptPath = join(directory, 'receipt.json');
  try {
    return releaseReceiptSchema.parse(releaseJson(receiptPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stage.attempts.at(-1)!.directory !== directory) throw new Error('Release attempt differs.');
  const input = join(directory, 'input.json');
  // A persisted input means the child may have started. Only the owner stage
  // has a serialized, resumable plan; other stages must never launch twice.
  try {
    releaseJson(input);
    let running = false;
    try {
      running = processAlive(
        releaseJson(join(directory, 'process.json')) as Parameters<typeof processAlive>[0],
      );
    } catch {
      /* Unknown process. */
    }
    if (name !== 'owner' || running)
      return {
        attemptId: attempt.id,
        status: 'unknown' as const,
        exitCode: null,
        signal: null,
        result: {},
        code: running ? 'RELEASE_RUNNING' : 'RELEASE_OUTCOME_UNKNOWN',
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  releaseSave(input, { journal, name, directory });
  const log = openSync(join(directory, 'child.log'), 'a', 0o600);
  let child;
  try {
    child = spawnSync(
      journal.node,
      [workerPath(new URL('./maintainer-release-worker.js', import.meta.url)), input],
      {
        stdio: ['ignore', log, log],
        env: childEnv({
          allow: [
            ...ownerEnvNames,
            'npm_execpath',
            'npm_config_cache',
            'npm_config_userconfig',
            'npm_config_globalconfig',
          ],
        }),
      },
    );
  } finally {
    closeSync(log);
  }
  try {
    return releaseReceiptSchema.parse(releaseJson(receiptPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    attemptId: attempt.id,
    status: 'unknown' as const,
    exitCode: child.status,
    signal: child.signal,
    result: {},
    code: 'RELEASE_OUTCOME_UNKNOWN',
  };
}
