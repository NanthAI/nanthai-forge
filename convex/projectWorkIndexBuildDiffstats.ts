// SPDX-License-Identifier: Apache-2.0
'use node';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { exchangeObjectReader } from './projectExchangeReader';
import { contextualHunks } from '../src/review-hunks';
import { reviewPaths } from '../src/native-source-review';
import type { BuildContext } from './projectWorkIndexBuildContext';
import type { ChangedStates, Pin, Stats } from './projectDiffstatProjection';
import type { Selected } from './projectWorkIndexBuildTypes';
import { invariant } from '../src/errors';
const pin = v.object({ sha256: v.string(), size: v.number() });
type File = { before?: Pin; after?: Pin };
type Counts = { add: number; del: number; exact: boolean };
const compareRef = makeFunctionReference<
  'action',
  {
    projectId: Selected['projectId'];
    actor: string;
    files: File[];
  },
  Counts[]
>('projectWorkIndexBuildDiffstats:compare');
/** One result per distinct blob pair, reused across the page's State pairs. */
export const compare = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    files: v.array(v.object({ before: v.optional(pin), after: v.optional(pin) })),
  },
  returns: v.array(v.object({ add: v.number(), del: v.number(), exact: v.boolean() })),
  handler: async (ctx, input) => {
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
export async function summaryDiffstats(
  ctx: ActionCtx,
  selected: Selected,
  context: BuildContext,
  changed: Map<string, ChangedStates>,
) {
  const paths = new Map(
    [...changed].map(([key, states]) => [
      key,
      reviewPaths(states.before, states.after).filter(f => f.status !== 'unchanged'),
    ]),
  );
  const files = new Map<string, File>();
  const fileKey = (file: { before?: { blob: string } | null; after?: { blob: string } | null }) =>
    JSON.stringify([file.before?.blob, file.after?.blob]);
  for (const values of paths.values())
    for (const file of values) {
      const before = file.before && context.pins.get(file.before.blob);
      const after = file.after && context.pins.get(file.after.blob);
      if ((file.before && !before) || (file.after && !after)) continue;
      files.set(fileKey(file), { ...(before ? { before } : {}), ...(after ? { after } : {}) });
    }
  const counts = new Map<string, Counts>(),
    pending = [...files];
  for (let offset = 0; offset < pending.length; offset += 50) {
    const page = pending.slice(offset, offset + 50);
    try {
      const values = await ctx.runAction(compareRef, {
        projectId: selected.projectId,
        actor: selected.owner,
        files: page.map(([, file]) => file),
      });
      page.forEach(([key], i) => counts.set(key, values[i]!));
    } catch {
      /* The ordinary diffstat fallback rechecks access and preserves unknown. */
    }
  }
  const result = new Map<string, Stats>();
  for (const [key, values] of paths) {
    const stats = values.map(file => counts.get(fileKey(file)));
    if (stats.some(s => !s)) continue;
    result.set(key, {
      files: values.length,
      ...(stats.every(s => s!.exact)
        ? {
            add: stats.reduce((n, s) => n + s!.add, 0),
            del: stats.reduce((n, s) => n + s!.del, 0),
          }
        : {}),
    });
  }
  return result;
}
