// SPDX-License-Identifier: Apache-2.0
'use node';
import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { indexReadContext } from './projectWorkIndexRetry';
import { exchangeObjectReader } from './projectExchangeReader';
import { contextualHunks } from '../src/review-hunks';
import type { Pin } from './projectDiffstatProjection';
import { invariant } from '../src/errors';
const pin = v.object({ sha256: v.string(), size: v.number() });
type File = { before?: Pin; after?: Pin };
type Counts = { add: number; del: number; exact: boolean };
/** One result per distinct blob pair, reused across the page's State pairs. */
export const compare = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    files: v.array(v.object({ before: v.optional(pin), after: v.optional(pin) })),
  },
  returns: v.array(v.object({ add: v.number(), del: v.number(), exact: v.boolean() })),
  handler: async (ctx, input) => {
    ctx = indexReadContext(ctx);
    invariant(input.files.length <= 50, 'BAD_ARGUMENT', 'Compare one changed-file window.');
    const reader = exchangeObjectReader(ctx, false, 0),
      result: Counts[] = [];
    for (let offset = 0; offset < input.files.length;) {
      const files: File[] = [],
        pins = new Map<string, Pin>();
      while (offset < input.files.length) {
        const file = input.files[offset]!;
        const next = new Map(pins);
        for (const pin of [file.before, file.after])
          if (pin && pin.size <= 1024 * 1024) next.set(pin.sha256, pin);
        if (files.length && [...next.values()].reduce((n, p) => n + p.size, 0) > 2 * 1024 * 1024) break;
        files.push(file);
        next.forEach((p, k) => pins.set(k, p));
        offset++;
      }
      const selected = [...pins.values()];
      const loaded = selected.length ? await reader.read(input.projectId, input.actor, selected) : [];
      const bytes = new Map(selected.map((pin, i) => [pin.sha256, loaded[i]!]));
      for (const file of files) {
        let add = 0,
          del = 0,
          exact = true;
        if ((file.before?.size ?? 0) > 1024 * 1024 || (file.after?.size ?? 0) > 1024 * 1024) exact = false;
        else {
          const before = file.before ? bytes.get(file.before.sha256)! : Buffer.alloc(0);
          const after = file.after ? bytes.get(file.after.sha256)! : Buffer.alloc(0);
          const compared = contextualHunks(before, after, 0);
          if (compared.truncated) exact = false;
          else if (!file.before || !file.after) {
            const text = new TextDecoder().decode(file.before ? before : after);
            const lines = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
            if (file.before) del = lines;
            else add = lines;
          } else
            for (const hunk of compared.hunks)
              for (const line of hunk.lines) {
                if (line.kind === 'added') add++;
                if (line.kind === 'removed') del++;
              }
        }
        result.push({ add, del, exact });
      }
    }
    return result;
  },
});
