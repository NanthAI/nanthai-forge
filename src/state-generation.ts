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
/** Most parents a State's object row records (Git's commit-graph keeps the same edges). A wider
 * merge keeps only its manifest; ancestry then reads that one State's bytes as before. */
export const stateParentsLimit = 16;
/** Exact parent digests of a hash-verified State, as its manifest lists them. */
export function validStateParents(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= stateParentsLimit &&
    value.every(id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) &&
    new Set(value).size === value.length
  );
}
