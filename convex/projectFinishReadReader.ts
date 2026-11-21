// SPDX-License-Identifier: Apache-2.0
import { hydrateLandingRequest } from './projectLandingRequestBody';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';
import { finishReadFields, type FinishReadKind } from './projectFinishReadProjection';
const readers = new WeakSet<object>();
const sourcePorts = new WeakMap<object, QueryCtx['db']>();
const olderProjects = new WeakSet<object>();
/** Decorate a read port without losing its source identity or applying projections twice. */
export function mapFinishReadPort(db: QueryCtx['db'], map: (db: QueryCtx['db']) => QueryCtx['db']) {
  const mapped = map(db);
  const source = sourcePorts.get(db);
  if (source) sourcePorts.set(mapped, map(source));
  return mapped;
}
/** Only legacy compatibility reads need the original project pointer until its next publication. */
export const finishReadSourceDb = (ctx: QueryCtx) => sourcePorts.get(ctx.db) ?? ctx.db;
export const isFinishReadReader = (ctx: QueryCtx) => readers.has(ctx);
const unpack = (db: QueryCtx['db'], row: Doc<'projectFinishReadRows'>) => {
  const value = { ...JSON.parse(row.value), _id: row.sourceId };
  if (row.kind === 'hostedProjects' && value.earlyResolutionEnabled === undefined) olderProjects.add(value);
  return row.kind === 'projectHostedLandingRequests' ? hydrateLandingRequest(db, value) : value;
};

/** Reuse the authorized project read. Older projections can recover explicit "off" from
 * the latest policy receipt, which is written atomically with every policy edit. */
export async function earlyResolutionForProject(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'> & { earlyResolutionEnabled?: boolean },
) {
  if (project.earlyResolutionEnabled !== undefined) return project.earlyResolutionEnabled;
  if (!olderProjects.has(project)) return effectivePolicy(project).acceptance.earlyResolve !== 'off';
  const latest = await ctx.db
    .query('projectPolicyChanges')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .order('desc')
    .first();
  return latest?.policy.acceptance.earlyResolve !== 'off';
}

/** Selected exact read paths only. Old untouched rows remain readable, with an
 * explicit source-row dependency until their next ordinary write installs the
 * projection. No reader backfill, polling, source scan or extra RPC. */
export function finishReadReader(ctx: QueryCtx, mode: 'pending' | 'owner' | 'plan' = 'pending'): QueryCtx {
  // The public boundary and handler can select different projection modes. Always wrap
  // the source port once, so a legacy/missing row never repeats the projection lookup.
  const db = sourcePorts.get(ctx.db) ?? ctx.db;
  const reader = {
    ...ctx,
    db: new Proxy(db, {
      get(target, key) {
        if (key === 'get')
          return async (id: string) => {
            const project = db.normalizeId('hostedProjects', id);
            const generation = mode === 'plan' && db.normalizeId('projectWorkGenerations', id);
            if (!project && !generation) return db.get(id as never);
            const kind = generation
              ? 'projectWorkGenerations'
              : mode === 'plan'
                ? 'projectPlanProjects'
                : 'hostedProjects';
            const row = await db
              .query('projectFinishReadRows')
              .withIndex('by_kind_and_source', q => q.eq('kind', kind).eq('sourceId', id))
              .unique();
            return row ? unpack(db, row) : db.get(id as never);
          };
        if (key === 'query')
          return (table: string) => {
            if (
              !(table in finishReadFields) ||
              [
                'projectHostedLandingAttempts',
                'projectHostedCheckRuns',
                'projectHostedChannels',
                'projectWorkGenerations',
              ].includes(table)
            )
              // oxlint-disable-next-line forge/convex-bounded-query -- pass-through: callers chain on ctx.db, linted at their own call sites
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
                    return row ? unpack(db, row) : legacy().unique();
                  },
                  take: async (count: number) => {
                    const rows = await projected.take(count);
                    return rows.length ? Promise.all(rows.map(row => unpack(db, row))) : legacy().take(count);
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
  sourcePorts.set(reader.db, db);
  return reader;
}
