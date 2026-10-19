// SPDX-License-Identifier: Apache-2.0
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { syncDirectory } from './native-durability.js';
import { readSource, safeRelative } from './files.js';
import { invariant } from './errors.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const syncSelection = z
  .object({ head: hash, channel: z.string(), target: hash, at: z.string(), request: hash })
  .strict();
export const syncApplication = z
  .object({ signature: hash, removing: z.array(z.string().refine(safeRelative)) })
  .strict();
export function readSyncJournal<T extends z.ZodType>(
  root: string,
  name: string,
  schema: T,
): z.infer<T> | undefined {
  try {
    lstatSync(join(root, '.forge', name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const bytes = readSource(root, `.forge/${name}`, Number.MAX_SAFE_INTEGER);
  invariant(
    bytes,
    'INVALID_SYNC_PLAN',
    'The retained sync plan is unavailable or unsafe. Existing work is retained.',
  );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    invariant(false, 'INVALID_SYNC_PLAN', 'The retained sync plan is invalid. Existing work is retained.');
  }
  const parsed = schema.safeParse(value);
  invariant(
    parsed.success,
    'INVALID_SYNC_PLAN',
    'The retained sync plan is invalid. Existing work is retained.',
  );
  return parsed.data;
}

/** A completed selection must not be mistaken for a pending sync after undo. */
export const syncSelectionName = (operationId: string) => `sync-${operationId}.json`;
export function clearSyncSelection(root: string, operationId: string) {
  const directory = join(root, '.forge');
  try {
    unlinkSync(join(directory, syncSelectionName(operationId)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  syncDirectory(directory);
}
