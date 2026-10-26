// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { mkdirBelow } from './mkdir-below.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkService } from './work.js';

const schema = z.object({
  schema: z.literal(1),
  channel: z.string(),
  generation: z.number().int().positive().safe(),
  id: z.uuid(),
});
export type LandingDriver = { generation: number; beforePublish: () => void };
/** Caller owns the channel's existing drain queue slot. A new generation fences
 * delayed publications, but never cancels the original check execution. This
 * owner-local journal is control state, not another queue or acceptance authority. */
export async function claimLandingDriver(work: WorkService, channel: string): Promise<LandingDriver> {
  const directory = join(work.store.directory, 'landing-drivers'),
    path = join(directory, `${digest(channel)}.json`),
    id = randomUUID();
  const read = () => (existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined);
  return retryWorkPhase(id, () =>
    work.store.lockedAsync(() => {
      const previous = read();
      invariant(
        !previous || previous.channel === channel,
        'INVALID_WORK_STORE',
        'Landing driver channel changed.',
      );
      const current = schema.parse({ schema: 1, channel, generation: (previous?.generation ?? 0) + 1, id });
      mkdirBelow(work.store.directory, directory);
      const temporary = `${path}.${id}`,
        file = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(file, JSON.stringify(current) + '\n');
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, path);
      const parent = openSync(dirname(path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      return {
        generation: current.generation,
        // Invoke under the SAME short Work lock as the mutable publication.
        beforePublish: () => {
          const saved = read();
          invariant(
            saved?.id === id && saved.generation === current.generation,
            'LANDING_DRIVER_STALE',
            'A replacement landing driver owns publication. Original work and runs are retained.',
          );
        },
      };
    }),
  );
}
