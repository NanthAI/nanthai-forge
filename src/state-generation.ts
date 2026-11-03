// SPDX-License-Identifier: Apache-2.0
/** Topological level, independent of timestamps. Unknown parents never acquire
 * a guessed level: old or incomplete history keeps ordinary ancestry traversal. */
export function validStateGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function nextStateGeneration(
  parents: readonly string[],
  generation: (id: string) => number | undefined,
): number | undefined {
  let maximum = 0;
  for (const id of parents) {
    const value = generation(id);
    if (!validStateGeneration(value)) return undefined;
    maximum = Math.max(maximum, value);
  }
  return maximum < Number.MAX_SAFE_INTEGER ? maximum + 1 : undefined;
}
