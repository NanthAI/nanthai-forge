// SPDX-License-Identifier: Apache-2.0
import type { ReturnAccounting } from './projectSourceReturnStep';

const limit = (raw: string | undefined) => {
  const value = Number(raw);
  return raw && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};
/** Optional per-invocation scheduling budget. Yield only after a committed step;
 * continuations start a fresh window without changing cumulative accounting. */
export function checkReturnBudget(
  accounting: Pick<ReturnAccounting, 'steps' | 'storageBytes'>,
  env: Record<string, string | undefined> = process.env,
) {
  const bytes = limit(env.FORGE_SOURCE_RETURN_MAX_STORAGE_BYTES),
    steps = limit(env.FORGE_SOURCE_RETURN_MAX_STEPS);
  return !!((bytes && accounting.storageBytes > bytes) || (steps && accounting.steps > steps));
}
