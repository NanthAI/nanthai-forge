// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import {
  finishReadFields,
  finishReadProjection,
  finishOwnerProjection,
  finishPeerProjection,
  finishAheadQueueProjection,
  type FinishReadKind,
} from './projectFinishReadProjection';

/** Same-transaction read models, with no RPC, scheduling, fan-out or source bytes.
 * Steady-state patches read the narrow projection, not the large source row.
 * Only a legacy row's first relevant write needs its selected source document. */
const wrapped = new WeakSet<object>();
export function finishReadWriter(ctx: MutationCtx): MutationCtx {
  // A retired/no-DB handler must still return before touching its context.
  let original: MutationCtx['db'] | undefined;
  const source = () => (original ??= ctx.db);
  const overrides = new Map<PropertyKey, unknown>();
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
    ...(kind === 'projectHostedFinishes' ? ['projectHostedFinishOwners'] : []),
    ...(kind === 'projectHostedLandingRequests' ? ['projectHostedLandingPeers'] : []),
    ...(kind === 'projectHostedLandingQueues' ? ['projectHostedAheadQueues'] : []),
  ];
  const project = (kind: FinishReadKind, selection: string, row: Record<string, unknown>) =>
    selection === 'projectHostedFinishOwners'
      ? finishOwnerProjection(row)
      : selection === 'projectHostedLandingPeers'
        ? finishPeerProjection(row)
        : selection === 'projectHostedAheadQueues'
          ? finishAheadQueueProjection(row)
          : finishReadProjection(kind, row);
  const writer = new Proxy({} as MutationCtx['db'], {
    has(_target, key) {
      return overrides.has(key) || Reflect.has(source(), key);
    },
    get(_target, key) {
      if (overrides.has(key)) return overrides.get(key);
      const db = source();
      if (wrapped.has(db)) {
        const value = Reflect.get(db, key);
        return typeof value === 'function' ? value.bind(db) : value;
      }
      if (key === 'insert')
        return async (table: string, value: Record<string, unknown>) => {
          if (!(table in finishReadFields)) return db.insert(table as never, value as never);
          return serial(async () => {
            const kind = table as FinishReadKind;
            const id = await db.insert(kind, value as never);
            for (const selection of selections(kind))
              await db.insert('projectFinishReadRows', project(kind, selection, { ...value, _id: id }));
            return id;
          });
        };
      if (key === 'patch' || key === 'replace' || key === 'delete')
        return async (id: string, value?: Record<string, unknown>) => {
          const kind = kindFor(id);
          const mutate = async () => {
            if (key === 'delete') await db.delete(id as never);
            else if (key === 'replace') await db.replace(id as never, value as never);
            else await db.patch(id as never, value as never);
          };
          if (!kind) return mutate();
          return serial(async () => {
            await mutate();
            if (
              key === 'patch' &&
              kind !== 'hostedProjects' &&
              !finishReadFields[kind].some(field => field in value!)
            )
              return;
            let legacy: Record<string, unknown> | null | undefined;
            for (const selection of selections(kind)) {
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
              const next = project(kind, selection, { ...source, _id: id });
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
  wrapped.add(writer);
  return new Proxy(ctx, {
    get(target, key, receiver) {
      return key === 'db' ? writer : Reflect.get(target, key, receiver);
    },
  });
}
