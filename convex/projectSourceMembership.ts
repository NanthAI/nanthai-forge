// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { record } from './projectWorkIndexStore';
// Query contexts are request-local. Share immutable parent reads across a page,
// after the caller has checked this request's current project authority.
const requests = new WeakMap<QueryCtx, Map<string, Promise<string[] | null>>>();
export async function sourceMembership(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  descendant: string,
  ancestor: string,
  visiting = new Set<string>(),
): Promise<boolean | null> {
  if (descendant === ancestor) return true;
  if (visiting.has(descendant)) return null;
  visiting.add(descendant);
  const closure = await record(ctx, partition, 'sourceAncestryClosure', descendant);
  if (closure) {
    const summary = JSON.parse(closure.value);
    const boundaries: string[] = [];
    for (let i = 0; i < summary.chunks; i++) {
      const chunk = await record(ctx, partition, 'sourceAncestryChunk', `${descendant}:${i}`);
      if (!chunk) return null;
      const value = JSON.parse(chunk.value);
      if (value.ancestors.includes(ancestor)) return true;
      boundaries.push(...(value.boundaries ?? []));
    }
    if (summary.complete) return false;
    let complete = boundaries.length > 0;
    for (const boundary of boundaries) {
      const included = await sourceMembership(ctx, partition, boundary, ancestor, new Set(visiting));
      if (included === true) return true;
      if (included === null) complete = false;
    }
    return complete ? false : null;
  }
  if (await record(ctx, partition, 'sourceAncestry', JSON.stringify([descendant, ancestor]))) return true;
  let cache = requests.get(ctx);
  if (!cache) {
    cache = new Map();
    requests.set(ctx, cache);
  }
  const parents = (head: string) => {
    const key = `${partition}:${head}`;
    let pending = cache!.get(key);
    if (!pending) {
      pending = (async () => {
        const row = await record(ctx, partition, 'sourceStateParents', head);
        if (!row) return null;
        const value = JSON.parse(row.value);
        if (value.parents) return value.parents as string[];
        const result: string[] = [];
        for (let i = 0; i < value.chunks; i++) {
          const chunk = await record(ctx, partition, 'sourceStateParentChunks', `${head}:${i}`);
          if (!chunk) return null;
          result.push(...JSON.parse(chunk.value).parents);
        }
        return result;
      })();
      cache!.set(key, pending);
    }
    return pending;
  };
  // Old pair tables covered only the old set of candidate heads. A newly
  // selected, previously retained ancestor still needs an exact answer.
  if (await parents(descendant)) {
    const pending = [descendant],
      seen = new Set<string>();
    let complete = true;
    while (pending.length) {
      const head = pending.pop()!;
      if (head === ancestor) return true;
      if (seen.has(head)) continue;
      seen.add(head);
      const values = await parents(head);
      if (values) pending.push(...values);
      else complete = false;
    }
    return complete ? false : null;
  }
  return (await record(ctx, partition, 'sourceAncestryHeads', descendant)) ? false : null;
}
