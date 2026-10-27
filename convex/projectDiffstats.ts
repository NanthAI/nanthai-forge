// SPDX-License-Identifier: Apache-2.0
'use node';
import { internalAction, type ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { exchangeObjectReader } from './projectExchangeReader';
import { invariant } from '../src/errors';
import { contextualHunks } from '../src/review-hunks';
import { meteredStorage, storageMeter } from './storageMeter';
const pin = v.object({ sha256: v.string(), size: v.number() });
/** Small changed-file batches; oversized/binary counts remain explicitly unknown. */
export const compare = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    files: v.array(v.object({ before: v.optional(pin), after: v.optional(pin) })),
  },
  returns: v.object({
    add: v.number(),
    del: v.number(),
    exact: v.boolean(),
    storageReads: v.optional(v.number()),
    storageBytes: v.optional(v.number()),
  }),
  handler: compareCounts,
});
/** Shared bounded comparison for eager source returns and explicit View opens. */
export async function compareCounts(
  unmetered: ActionCtx,
  input: {
    projectId: import('./_generated/dataModel').Id<'hostedProjects'>;
    actor: string;
    files: { before?: { sha256: string; size: number }; after?: { sha256: string; size: number } }[];
  },
) {
  const ctx = meteredStorage(unmetered),
    reader = exchangeObjectReader(ctx, false, 0);
  let add = 0,
    del = 0,
    exact = true;
  const small = input.files.filter(
    file => (file.before?.size ?? 0) <= 1024 * 1024 && (file.after?.size ?? 0) <= 1024 * 1024,
  );
  if (small.length < input.files.length) exact = false;
  const sizes = new Map<string, number>();
  for (const file of small)
    for (const pin of [file.before, file.after])
      if (pin) {
        invariant(
          !sizes.has(pin.sha256) || sizes.get(pin.sha256) === pin.size,
          'INVALID_WORK_BACKUP',
          'Identical content has inconsistent sizes.',
        );
        sizes.set(pin.sha256, pin.size);
      }
  // Resolve all pins in a transport window together, rather than twice per
  // before/after file. Bound both the metadata query and resident blob bytes.
  for (let offset = 0; offset < small.length;) {
    const files: typeof small = [],
      pins: { sha256: string; size: number }[] = [];
    const indices = new Map<string, number>();
    let bytes = 0;
    while (offset < small.length && files.length < 50) {
      const file = small[offset]!;
      const next = [file.before, file.after].filter(p => p && !indices.has(p.sha256));
      const size = next.reduce((sum, p) => sum + p!.size, 0);
      if (files.length && bytes + size > 2 * 1024 * 1024) break;
      files.push(file);
      offset++;
      for (const pin of next)
        if (pin && !indices.has(pin.sha256)) {
          indices.set(pin.sha256, pins.length);
          pins.push(pin);
          bytes += pin.size;
        }
    }
    const loaded = pins.length ? await reader.read(input.projectId, input.actor, pins) : [];
    for (const file of files) {
      const before = file.before ? loaded[indices.get(file.before.sha256)!]! : Buffer.alloc(0);
      const after = file.after ? loaded[indices.get(file.after.sha256)!]! : Buffer.alloc(0);
      const compared = contextualHunks(before, after, 0);
      if (compared.truncated) {
        exact = false;
        continue;
      }
      if (!file.before || !file.after) {
        const bytes = file.before ? before : after;
        const text = new TextDecoder().decode(bytes);
        const lines = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
        if (file.before) del += lines;
        else add += lines;
      } else
        for (const hunk of compared.hunks)
          for (const line of hunk.lines) {
            if (line.kind === 'added') add++;
            if (line.kind === 'removed') del++;
          }
    }
  }
  const meter = storageMeter(ctx);
  return { add, del, exact, storageReads: meter.reads, storageBytes: meter.bytes };
}
