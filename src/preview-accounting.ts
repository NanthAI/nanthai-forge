import { CoordinationJournal } from './agent-coordination-journal.js';
import { PeersCache } from './agent-peers-cache.js';
import { digest } from './hash.js';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkCostSchema } from './check-cost.js';
import type { WorkStore } from './work-store.js';

export const previewMeasurementSchema = z.object({
  executionId: z.uuid(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative().finite(),
  inputs: z.array(z.object({ laneId: z.uuid(), head: z.string() })),
  cost: checkCostSchema,
});
/** Reuse the existing private advisory journal; no Work mutation or source changes. */
export function retainPreviewMeasurement(
  store: WorkStore,
  measurement: z.infer<typeof previewMeasurementSchema>,
) {
  new CoordinationJournal(store).recordPreview(previewMeasurementSchema.parse(measurement));
}

/** Finite reads in 100-record pages; no subscriptions or background work. */
export function previewMeasurements(directory: string) {
  let names: string[];
  const path = join(directory, 'coordination');
  try {
    invariant(
      !lstatSync(path).isSymbolicLink(),
      'COORDINATION_UNAVAILABLE',
      'Local coordination journal is redirected.',
    );
    names = readdirSync(path)
      .filter(name => /^preview-cost-[0-9a-f-]+\.json$/.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: '', rows: [] };
    throw error;
  }
  const version = digest(JSON.stringify(names));
  const cache = new PeersCache(directory),
    key = `preview-cost-v1:${version}`;
  const cached = cache.read<z.infer<typeof previewMeasurementSchema>[]>(key);
  if (cached) return { version, rows: cached };
  const rows: z.infer<typeof previewMeasurementSchema>[] = [];
  for (let offset = 0; offset < names.length; offset += 100)
    for (const name of names.slice(offset, offset + 100)) {
      const file = join(path, name),
        stat = lstatSync(file);
      invariant(
        stat.isFile() && !stat.isSymbolicLink(),
        'COORDINATION_UNAVAILABLE',
        'Preview measurement is unavailable.',
      );
      rows.push(previewMeasurementSchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
    }
  cache.write(key, rows);
  return { version, rows };
}
