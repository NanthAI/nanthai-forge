// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from '../src/errors';
import type { ReturnAccounting } from './projectSourceReturnStep';

const limit = (raw: string | undefined) => {
  const value = Number(raw);
  return raw && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};
/** Optional per-push stop, off unless the deployment sets a limit. The stop is
 * after a committed step, so pushing the same operation again resumes it. */
export function checkReturnBudget(
  accounting: ReturnAccounting,
  env: Record<string, string | undefined> = process.env,
) {
  const bytes = limit(env.FORGE_SOURCE_RETURN_MAX_STORAGE_BYTES),
    steps = limit(env.FORGE_SOURCE_RETURN_MAX_STEPS);
  if ((bytes && accounting.storageBytes > bytes) || (steps && accounting.steps > steps))
    throw new ForgeError(
      'SOURCE_RETURN_BUDGET',
      `Source return paused at its per-push budget after ${accounting.steps} steps and ${accounting.storageBytes} storage bytes read (limits: ${steps ?? 'none'} steps, ${bytes ?? 'none'} bytes). Progress is saved. Raise or unset FORGE_SOURCE_RETURN_MAX_STEPS / FORGE_SOURCE_RETURN_MAX_STORAGE_BYTES on the deployment, then push again to resume the same operation.`,
    );
}
