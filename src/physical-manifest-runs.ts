// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { physicalKey } from './physical-manifest-binary.js';
import { packRunMaxBytes } from './object-pack-range.js';
import type { PhysicalEntry, PhysicalPin } from './physical-manifest-codec.js';
/** A physical interval contains exactly the requested members, including singleton ranges. */
export type PhysicalRun = {
  digest: string;
  offset: number;
  length: number;
  total: number;
  raw?: true;
  nonce?: string;
};
export async function physicalRuns(entries: AsyncIterable<PhysicalEntry> | Iterable<PhysicalPin>) {
  const packs = new Map<string, { digest: string; nonce?: string; total: number; spans: number[] }>(),
    runs: PhysicalRun[] = [];
  for await (const entry of entries) {
    if ('recipe' in entry && entry.recipe) return null;
    if (!entry.pack) {
      physicalKey(entry.sha256, entry.nonce);
      runs.push({
        digest: entry.sha256,
        offset: 0,
        length: entry.size,
        total: entry.size,
        raw: true,
        ...(entry.nonce === undefined ? {} : { nonce: entry.nonce }),
      });
      continue;
    }
    const { digest, size, offset, nonce } = entry.pack;
    const key = physicalKey(digest, nonce);
    let group = packs.get(key);
    if (!group)
      packs.set(key, (group = { digest, ...(nonce === undefined ? {} : { nonce }), total: size, spans: [] }));
    invariant(group.total === size, 'SOURCE_HASH_MISMATCH', 'Physical pack size changed.');
    group.spans.push(offset, entry.size);
  }
  for (const { digest, nonce, total, spans } of packs.values()) {
    const order = Array.from({ length: spans.length / 2 }, (_, index) => index * 2);
    order.sort((a, b) => spans[a]! - spans[b]!);
    let run: PhysicalRun | undefined;
    for (const index of order) {
      const offset = spans[index]!,
        length = spans[index + 1]!;
      invariant(
        length > 0 && offset >= 0 && offset + length <= total && (!run || offset >= run.offset + run.length),
        'SOURCE_HASH_MISMATCH',
        'Physical intervals overlap or exceed their pack.',
      );
      if (run && offset === run.offset + run.length && run.length + length <= packRunMaxBytes)
        run.length += length;
      else {
        run = { digest, offset, length, total, ...(nonce === undefined ? {} : { nonce }) };
        runs.push(run);
      }
    }
  }
  return runs;
}
export function physicalRunFor(runs: readonly PhysicalRun[], entry: PhysicalEntry) {
  return runs.find(
    run =>
      run.digest === (entry.pack?.digest ?? entry.sha256) &&
      run.nonce === (entry.pack?.nonce ?? entry.nonce) &&
      (entry.pack
        ? !run.raw &&
          run.offset <= entry.pack.offset &&
          run.offset + run.length >= entry.pack.offset + entry.size
        : run.raw && run.length === entry.size),
  );
}
