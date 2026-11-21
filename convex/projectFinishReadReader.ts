// SPDX-License-Identifier: Apache-2.0
import { hydrateLandingRequest } from './projectLandingRequestBody';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';
import { finishReadFields, type FinishReadKind } from './projectFinishReadProjection';
const readers = new WeakSet<object>();
type ReadMode = 'pending' | 'owner' | 'plan';
type ProjectRead = { exact?: string };
const ports = new WeakMap<object, { source: QueryCtx['db']; mode: ReadMode; projectRead: ProjectRead }>();
/** Decorate a read port without losing its source identity or applying projections twice. */
export function mapFinishReadPort(db: QueryCtx['db'], map: (db: QueryCtx['db']) => QueryCtx['db']) {
  const mapped = map(db);
  const port = ports.get(db);
  if (port) ports.set(mapped, { ...port, source: map(port.source) });
  return mapped;
}
/** Read fields deliberately absent from a projection via the original transaction port. */
export const finishReadSourceDb = (ctx: QueryCtx) => ports.get(ctx.db)?.source ?? ctx.db;
/** Use the project row for this query's authorization read when the held attempt needs its policy. */
export function selectExactFinishProject(ctx: QueryCtx, projectId: string) {
  const port = ports.get(ctx.db);
  if (port) port.projectRead.exact = projectId;
}
export const isFinishReadReader = (ctx: QueryCtx) => readers.has(ctx);
const unpack = (db: QueryCtx['db'], row: Doc<'projectFinishReadRows'>) => {
  const value = { ...JSON.parse(row.value), _id: row.sourceId };
  return row.kind === 'projectHostedLandingRequests' ? hydrateLandingRequest(db, value) : value;
};

/** Reuse the authorized project read. Older projections can recover explicit "off" from
 * the latest policy receipt, which is written atomically with every policy edit. */
export async function earlyResolutionForProject(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'> & { earlyResolutionEnabled?: boolean },
) {
  if (project.earlyResolutionEnabled !== undefined) return project.earlyResolutionEnabled;
  if (project._creationTime !== undefined) return effectivePolicy(project).acceptance.earlyResolve !== 'off';
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
export function finishReadReader(ctx: QueryCtx, mode: ReadMode = 'pending'): QueryCtx {
  const port = ports.get(ctx.db);
  // Keep the public finish read's request-local document reuse for its pending snapshot and board.
  if (mode === 'pending' && port?.mode === mode) {
    readers.add(ctx);
    return ctx;
  }
  const db = port?.source ?? ctx.db;
  const projectRead: ProjectRead = port?.projectRead ?? {};
  const reader = {
    ...ctx,
    db: new Proxy(db, {
      get(target, key) {
        if (key === 'get')
          return async (id: string) => {
            if (id === projectRead.exact) return db.get(id as never);
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
  ports.set(reader.db, { source: db, mode, projectRead });
  return reader;
}
