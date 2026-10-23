// SPDX-License-Identifier: Apache-2.0
'use node';
import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { exchangeObjectReader } from './projectExchangeReader';
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
  handler: async (unmetered, input) => {
    const ctx = meteredStorage(unmetered),
      reader = exchangeObjectReader(ctx, false, 0);
    const read = async (selected?: { sha256: string; size: number }) =>
      selected ? (await reader.read(input.projectId, input.actor, [selected]))[0]! : Buffer.alloc(0);
    let add = 0,
      del = 0,
      exact = true;
    const small = input.files.filter(
      file => (file.before?.size ?? 0) <= 1024 * 1024 && (file.after?.size ?? 0) <= 1024 * 1024,
    );
    if (small.length < input.files.length) exact = false;
    // Callers bound a batch's small-file bytes; overlap a few reads per batch.
    const loaded: [Buffer, Buffer][] = [];
    for (let i = 0; i < small.length; i += 8)
      loaded.push(
        ...(await Promise.all(
          small
            .slice(i, i + 8)
            .map(async file => [await read(file.before), await read(file.after)] as [Buffer, Buffer]),
        )),
      );
    for (const [index, file] of small.entries()) {
      const [before, after] = loaded[index]!;
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
    const meter = storageMeter(ctx);
    return { add, del, exact, storageReads: meter.reads, storageBytes: meter.bytes };
  },
});
