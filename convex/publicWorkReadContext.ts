// SPDX-License-Identifier: Apache-2.0
import type { PublicPlanRoot } from './publicWorkPlan';
import type { QueryCtx } from './_generated/server';
import { mapFinishReadPort } from './projectFinishReadReader';
/** Track canonical Work rows already read by a handler. Source bytes never select a visibility policy.
 * This adds no DB operation and keeps the query's ordinary reactive dependencies. */
export function publicWorkReadContext(ctx: QueryCtx) {
  let planning = false,
    lanes = false,
    internalPlan = false;
  const roots = new Map<string, PublicPlanRoot>();
  const inspect = (row: unknown) => {
    if (!row || typeof row !== 'object') return;
    const value = row as Record<string, unknown>;
    if (typeof value.collection === 'string' && value.collection.startsWith('_workStorePlan'))
      internalPlan = true;
    if (value.collection === 'planningSearch' && typeof value.value === 'string') {
      const root = JSON.parse(value.value) as PublicPlanRoot;
      if (typeof root.id === 'string' && typeof root.kind === 'string') roots.set(root.id, root);
    }
    if (
      (typeof value.collection === 'string' &&
        (value.collection.startsWith('planning') || value.collection.startsWith('_workStorePlan'))) ||
      ['issue', 'comment'].includes(value.kind as string) ||
      typeof value.itemId === 'string'
    )
      planning = true;
    if (typeof value.metadata === 'string') {
      try {
        const counts = JSON.parse(value.metadata).counts ?? {};
        if (Object.keys(counts).some(key => key.startsWith('planning'))) planning = true;
      } catch {
        // Only generation metadata participates, never a member's prose.
      }
    }
    if (
      typeof value.laneId === 'string' ||
      ['lane', 'intent'].includes(value.kind as string) ||
      ['lanes', 'intents'].includes(value.collection as string)
    )
      lanes = true;
  };
  const chain = (target: object): object =>
    new Proxy(target, {
      get(original, key) {
        const value = Reflect.get(original, key);
        if (['withIndex', 'withSearchIndex', 'order', 'filter'].includes(key as string))
          return (...args: unknown[]) => chain(value.apply(original, args));
        if (['take', 'collect', 'unique', 'first', 'paginate'].includes(key as string))
          return async (...args: unknown[]) => {
            const result = await value.apply(original, args);
            const rows =
              key === 'paginate'
                ? result.page
                : ['take', 'collect'].includes(key as string)
                  ? result
                  : [result];
            for (const row of rows) inspect(row);
            return result;
          };
        if (key === Symbol.asyncIterator)
          return async function* () {
            for await (const row of original as AsyncIterable<unknown>) {
              inspect(row);
              yield row;
            }
          };
        return typeof value === 'function' ? value.bind(original) : value;
      },
    });
  const observeDb = (source: QueryCtx['db']) =>
    new Proxy(source, {
      get(target, key) {
        if (key === 'query')
          return (table: Parameters<QueryCtx['db']['query']>[0]) => chain(target.query(table));
        if (key === 'get')
          return async (...args: Parameters<QueryCtx['db']['get']>) => {
            const row = await target.get(...args);
            inspect(row);
            return row;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  let db: QueryCtx['db'] | undefined;
  return {
    ctx: new Proxy(ctx, {
      // Retired handlers must retain their upgrade error without opening any runtime port.
      get: (target, key, receiver) =>
        key === 'db' ? (db ??= mapFinishReadPort(target.db, observeDb)) : Reflect.get(target, key, receiver),
    }),
    scope: () => ({ planning, lanes, roots, internalPlan }),
  };
}
