// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { NativeSource, overlappingPaths } from './native-source.js';
import type { ChannelMove, CheckRun } from './work-types.js';

/** Every subset is exact and memoized by the caller. Both halves are checked:
 * multiple independent culprits and interacting changes are retained. */
export async function bisectLandings<T>(
  items: T[],
  check: (items: T[]) => Promise<CheckRun['status']>,
): Promise<T[]> {
  const status = await check(items);
  if (status === 'passed') return [];
  if (status !== 'failed')
    throw new ForgeError('CANCELLED', 'Recovery check is inconclusive; retain source and retry recovery.');
  if (items.length <= 1) return items;
  const middle = Math.floor(items.length / 2);
  const left = await bisectLandings(items.slice(0, middle), check);
  const right = await bisectLandings(items.slice(middle), check);
  // Neither side reproduces alone: preserve the interacting set as the attribution.
  return left.length || right.length ? [...left, ...right] : items;
}

/** Reverse a landed delta on current source using ordinary three-way text merge.
 * Synthetic reverse ancestry fixes the merge base at the original landing. */
export function reverseLandings(source: NativeSource, head: string, moves: ChannelMove[], at: string) {
  for (const move of [...moves].reverse()) {
    if (!move.previous) return undefined;
    const reverse = source.writeState(
      source.state(move.previous).files,
      [move.head],
      'Compensating reverse delta',
      at,
    );
    const merged = source.compose(head, reverse, 'Compensating optimistic landing revert', at);
    if (!merged.head) return undefined;
    head = merged.head;
  }
  if (overlappingPaths(source.state(head).files).length) return undefined;
  return head;
}
