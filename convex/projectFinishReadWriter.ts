// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { publishLegacyLineMain } from './projectLiveLineLegacy';
import { patchLineLane } from './projectLiveLineStore';
import { transitionLineSubmission } from './projectLiveLineSubmission';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { workRecordOriginalDb } from './projectWorkRecordWriter';
import type { MutationCtx } from './_generated/server';
import { metricReadWriter } from './projectMetricReadWriter';
import { writeWithMetricAliases } from './projectMetricAliasWriter';
import { planHeaderFits, planProjectHeaderWanted } from './projectPlanHeaderStore';
import {
  finishReadFields,
  finishReadProjection,
  finishOwnerProjection,
  finishPeerProjection,
  finishAheadQueueProjection,
  finishPlanProjectProjection,
  type FinishReadKind,
} from './projectFinishReadProjection';

/** Same-transaction read models, with no RPC, scheduling, fan-out or source bytes.
 * Steady-state patches read the narrow projection, not the large source row.
 * Only a legacy row's first relevant write needs its selected source document. */
const wrapped = new WeakMap<object, () => MutationCtx['db']>();
/** The database beneath one finish-read writer (reads are unchanged by it; it only adds write upkeep). */
export const finishReadOriginalDb = (db: MutationCtx['db']) => wrapped.get(db)?.() ?? db;
/** Validated permanent purge and verified capsule removal own companion disposition.
 * Their inventories remove or retain each companion explicitly, including prior-page work.
 * Keeping ordinary projection upkeep here would double-delete or recreate them. */
export function projectPurgeWriter(ctx: MutationCtx): MutationCtx {
  const original = wrapped.get(landingRequestOriginalDb(workRecordOriginalDb(ctx.db)));
  return original
    ? new Proxy(ctx, {
        get(target, key, receiver) {
          return key === 'db' ? original() : Reflect.get(target, key, receiver);
        },
      })
    : ctx;
}
export function finishReadWriter(ctx: MutationCtx): MutationCtx {
  // A retired/no-DB handler must still return before touching its context.
  let original: MutationCtx['db'] | undefined;
  const source = () => (original ??= ctx.db);
  const overrides = new Map<PropertyKey, unknown>();
  let metrics: ReturnType<typeof metricReadWriter> | undefined;
  const metric = () => (metrics ??= metricReadWriter(source()));
  let tail = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const next = tail.then(work);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const kindFor = (id: string) =>
    (Object.keys(finishReadFields) as FinishReadKind[]).find(kind => source().normalizeId(kind, id) !== null);
  const selections = (kind: FinishReadKind) => [
    kind,
    ...(kind === 'hostedProjects' ? ['projectPlanProjects'] : []),
    ...(kind === 'projectHostedFinishes' ? ['projectHostedFinishOwners'] : []),
    ...(kind === 'projectHostedLandingRequests' ? ['projectHostedLandingPeers'] : []),
    ...(kind === 'projectHostedLandingQueues' ? ['projectHostedAheadQueues'] : []),
  ];
  const project = (kind: FinishReadKind, selection: string, row: Record<string, unknown>) =>
    selection === 'projectPlanProjects'
      ? finishPlanProjectProjection(row)
      : selection === 'projectHostedFinishOwners'
        ? finishOwnerProjection(row)
        : selection === 'projectHostedLandingPeers'
          ? finishPeerProjection(row)
          : selection === 'projectHostedAheadQueues'
            ? finishAheadQueueProjection(row)
            : finishReadProjection(kind, row);
  const fits = (
    kind: FinishReadKind,
    selection: string,
    row: { value: string },
    source: Record<string, unknown>,
  ) =>
    (selection !== 'projectPlanProjects' || planProjectHeaderWanted(source)) &&
    ((kind !== 'projectWorkGenerations' && selection !== 'projectPlanProjects') || planHeaderFits(row.value));
  const writer = new Proxy({} as MutationCtx['db'], {
    has(_target, key) {
      return overrides.has(key) || Reflect.has(source(), key);
    },
    get(_target, key) {
      if (overrides.has(key)) return overrides.get(key);
      const db = source();
      if (wrapped.has(landingRequestOriginalDb(db))) {
        const value = Reflect.get(db, key);
        return typeof value === 'function' ? value.bind(db) : value;
      }
      if (key === 'query' && typeof db.query === 'function') return metric().query;
      if (key === 'get' && typeof db.get === 'function') return metric().get;
      if (key === 'insert')
        return async (table: string, value: Record<string, unknown>) => {
          if (!(table in finishReadFields)) return db.insert(table as never, value as never);
          return serial(async () => {
            const kind = table as FinishReadKind;
            const id = await writeWithMetricAliases(db, value, () => db.insert(kind, value as never));
            for (const selection of selections(kind)) {
              const row = project(kind, selection, { ...value, _id: id });
              if (fits(kind, selection, row, value)) await db.insert('projectFinishReadRows', row);
            }
            return id;
          });
        };
      if (key === 'patch' || key === 'replace' || key === 'delete')
        return async (id: string, value?: Record<string, unknown>) => {
          const kind = kindFor(id);
          let selected = value;
          const mutate = async () => {
            if (key === 'delete') await db.delete(id as never);
            else
              await writeWithMetricAliases(db, selected!, () =>
                key === 'replace'
                  ? db.replace(id as never, selected as never)
                  : db.patch(id as never, selected as never),
              );
          };
          if (!kind) {
            if (key === 'patch' && db.normalizeId('projectHostedOverlapLanes', id))
              return serial(async () => {
                await patchLineLane(
                  db,
                  id as import('./_generated/dataModel').Id<'projectHostedOverlapLanes'>,
                  value!,
                );
                return mutate();
              });
            return mutate();
          }
          return serial(async () => {
            if (kind === 'projectHostedCheckRuns') selected = await metric().write(id, key, value);
            await mutate();
            if (
              key === 'patch' &&
              kind !== 'hostedProjects' &&
              !finishReadFields[kind].some(field => field in value!)
            )
              return;
            let legacy: Record<string, unknown> | null | undefined;
            for (const selection of selections(kind)) {
              // Journal/controller-only patches must not add a Plan lookup per wake.
              if (
                selection === 'projectPlanProjects' &&
                key === 'patch' &&
                ![...finishReadFields.hostedProjects, 'work'].some(field => field in value!)
              )
                continue;
              const old = await db
                .query('projectFinishReadRows')
                .withIndex('by_kind_and_source', q => q.eq('kind', selection).eq('sourceId', id))
                .unique();
              if (key === 'delete') {
                if (old) await db.delete(old._id);
                continue;
              }
              let source: Record<string, unknown>;
              if (key === 'replace') source = value!;
              else if (old)
                source = {
                  ...old,
                  ...JSON.parse(old.value),
                  ...value,
                };
              else {
                legacy ??= await db.get(id as never);
                source = legacy!;
              }
              const work = source.work as
                | { generationId?: import('./_generated/dataModel').Id<'projectWorkGenerations'> }
                | undefined;
              if (
                kind === 'hostedProjects' &&
                work?.generationId &&
                (source.sourceAuthority as { mode?: string } | undefined)?.mode !== 'server'
              )
                await publishLegacyLineMain(
                  db,
                  id as import('./_generated/dataModel').Id<'hostedProjects'>,
                  work.generationId,
                );
              if (kind === 'projectHostedLandingRequests' && selection === kind && old) {
                const before = JSON.parse(old.value);
                await transitionLineSubmission(
                  { db },
                  {
                    ...JSON.parse(before.value),
                    id: before.submissionId,
                    projectId: before.projectId,
                    phase: before.phase,
                    held: Boolean(before.hold),
                    hold: before.hold ?? null,
                  },
                  {
                    ...JSON.parse(source.value as string),
                    id: source.submissionId,
                    projectId: source.projectId,
                    phase: source.phase,
                    held: Boolean(source.hold),
                    hold: (source.hold as string | undefined) ?? null,
                  },
                );
              }
              const next = project(kind, selection, { ...source, _id: id });
              // Oversized optional headers retain the exact source reader; they
              // never make an otherwise valid project/generation write fail.
              if (!fits(kind, selection, next, source)) {
                if (old) await db.delete(old._id);
                continue;
              }
              if (!old) await db.insert('projectFinishReadRows', next);
              else if (old.value !== next.value) await db.replace(old._id, next);
            }
          });
        };
      const value = Reflect.get(db, key);
      return typeof value === 'function' ? value.bind(db) : value;
    },
    set(_target, key, value) {
      // Decorating this context's methods must not replace the underlying port
      // with a function that recursively calls its own projection wrapper.
      overrides.set(key, value);
      return true;
    },
  });
  wrapped.set(writer, () => {
    const db = landingRequestOriginalDb(source());
    return wrapped.get(db)?.() ?? db;
  });
  return new Proxy(ctx, {
    get(target, key, receiver) {
      return key === 'db' ? writer : Reflect.get(target, key, receiver);
    },
  });
}
