// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { finishReadFields, type FinishReadKind } from './projectFinishReadProjection';
const readers = new WeakSet<object>();
export const isFinishReadReader = (ctx: QueryCtx) => readers.has(ctx);
const unpack = (row: Doc<'projectFinishReadRows'>) => ({ ...JSON.parse(row.value), _id: row.sourceId });
/** Selected exact read paths only. Old untouched rows remain readable, with an
 * explicit source-row dependency until their next ordinary write installs the
 * projection. No reader backfill, polling, source scan or extra RPC. */
export function finishReadReader(ctx: QueryCtx, mode: 'pending' | 'owner' = 'pending'): QueryCtx {
  const db = ctx.db;
  const reader = {
    ...ctx,
    db: new Proxy(db, {
      get(target, key) {
        if (key === 'get')
          return async (id: string) => {
            if (!db.normalizeId('hostedProjects', id)) return db.get(id as never);
            const row = await db
              .query('projectFinishReadRows')
              .withIndex('by_kind_and_source', q => q.eq('kind', 'hostedProjects').eq('sourceId', id))
              .unique();
            return row ? unpack(row) : db.get(id as never);
          };
        if (key === 'query')
          return (table: string) => {
            if (
              !(table in finishReadFields) ||
              ['projectHostedLandingAttempts', 'projectHostedCheckRuns', 'projectHostedChannels'].includes(
                table,
              )
            )
              return db.query(table as never);
            const original = db.query(table as FinishReadKind);
            const kind =
              table === 'projectHostedFinishes' && mode === 'owner' ? 'projectHostedFinishOwners' : table;
            return {
              withIndex: (index: string, select: (q: unknown) => unknown) => {
                const projected = db
                  .query('projectFinishReadRows')
                  .withIndex(
                    index.replace(/^by_/, 'by_kind_and_') as 'by_kind_and_project_and_submission',
                    q => select(q.eq('kind', kind)) as never,
                  );
                const legacy = () => original.withIndex(index as never, select as never);
                return {
                  unique: async () => {
                    const row = await projected.unique();
                    return row ? unpack(row) : legacy().unique();
                  },
                  take: async (count: number) => {
                    const rows = await projected.take(count);
                    return rows.length ? rows.map(unpack) : legacy().take(count);
                  },
                };
              },
            };
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  readers.add(reader);
  return reader;
}
