// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { r2Config, presignGet } from './r2';
import { packRange, packHeaders, packRuns, type ObjectPack } from '../src/object-pack-range';

/** One ranged GET for back-to-back requested objects; `url` rides on one member only. */
export const runValue = v.optional(
  v.object({
    id: v.number(),
    offset: v.number(),
    length: v.number(),
    total: v.number(),
    url: v.optional(v.string()),
  }),
);
export type RunBinding = { id: number; offset: number; length: number; total: number; url?: string };

/** Signs one interval per run of requested neighbours (exactly their bytes, never a gap)
 * and one range per remaining packed row, so a page costs runs + singletons signatures. */
export async function signRuns(
  result: { url?: string; run?: RunBinding }[],
  packed: { index: number; size: number; pack: ObjectPack; key: string }[],
) {
  const config = r2Config(),
    member = new Set<number>(),
    keys = new Map(packed.map(row => [row.index, row.key]));
  for (const [id, run] of packRuns(packed).entries()) {
    const url = await presignGet(config, keys.get(run.members[0]!)!, packHeaders(run, run.length));
    for (const [at, index] of run.members.entries()) {
      member.add(index);
      result[index]!.run = {
        id,
        offset: run.offset,
        length: run.length,
        total: run.total,
        ...(at ? {} : { url }),
      };
    }
  }
  for (const row of packed)
    if (!member.has(row.index))
      result[row.index]!.url = await presignGet(config, row.key, packHeaders(packRange(row), row.size));
}
