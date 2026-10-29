// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from './work-types.js';

export type ReturnValidationChunk = {
  data: WorkData;
  collection?: string;
  offset: number;
  hostedMoves: number;
};
/** Retain original array order, including duplicate IDs and opaque extensions.
 * A single indivisible record may exceed the target; this is a scheduling hint,
 * never a limit on the Work an owner may return. */
export function* sourceReturnChunks(current: WorkData, target = 256 * 1024) {
  const empty = Object.fromEntries(
    Object.entries(current).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  ) as unknown as WorkData;
  const hostedMoves = current.hostedChannelMoves?.length ?? 0;
  yield { data: empty, offset: 0, hostedMoves } satisfies ReturnValidationChunk;
  for (const [collection, values] of Object.entries(current)) {
    if (!Array.isArray(values)) continue;
    let offset = 0,
      batch: unknown[] = [],
      bytes = 0;
    for (const value of values) {
      const size = Buffer.byteLength(JSON.stringify(value) ?? 'null');
      if (batch.length && bytes + size > target) {
        yield { data: { ...empty, [collection]: batch }, collection, offset, hostedMoves };
        offset += batch.length;
        batch = [];
        bytes = 0;
      }
      batch.push(value);
      bytes += size;
    }
    if (batch.length) yield { data: { ...empty, [collection]: batch }, collection, offset, hostedMoves };
  }
}
