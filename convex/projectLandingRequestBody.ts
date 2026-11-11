// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

type Row = Record<string, unknown> & { _id?: string; value?: string; requestBodyId?: string };
type Port = QueryCtx['db'];
const tag = Symbol('landingRequestBodies');
const originals = new WeakMap<object, () => Port>();
export const landingRequestOriginalDb = <D extends Port>(db: D): D => (originals.get(db)?.() ?? db) as D;
/** Permanent/orphan purge bypasses ordinary writers; both use this same parent-owned cleanup. */
export async function deleteLandingRequestBodies(db: MutationCtx['db'], row: Row) {
  const bodies = [];
  for (const pointer of ['requestBodyId', 'selectionBodyId']) {
    const id = row[pointer];
    if (typeof id !== 'string') continue;
    const body = await db.get(id as Id<'projectHostedLandingBodies'>);
    if (!body) continue; // A resumed cleanup may already have removed a companion.
    const cold = JSON.parse(body.value);
    invariant(
      cold.projectId === row.projectId && cold.submissionId === row.submissionId,
      'EVIDENCE_CHANGED',
      'The landing request body belongs to another ticket.',
    );
    bodies.push(body);
  }
  for (const body of bodies) await db.delete(body._id);
  return bodies;
}
/** The body is owned exclusively by its ticket. No index, scan, migration or RPC is needed. */
export async function hydrateLandingRequest(db: Port, row: Row | null): Promise<Row | null> {
  if (!row) return row;
  const result = { ...row };
  for (const [pointer, field] of [
    ['requestBodyId', 'request'],
    ['selectionBodyId', 'batchSelection'],
  ] as const) {
    const id = row[pointer];
    if (typeof id !== 'string') continue;
    const body = await db.get(id as Id<'projectHostedLandingBodies'>);
    invariant(body, 'SOURCE_UNAVAILABLE', 'The landing request body is unavailable.');
    const cold = JSON.parse(body.value);
    invariant(
      cold.projectId === row.projectId && cold.submissionId === row.submissionId,
      'EVIDENCE_CHANGED',
      'The landing request body belongs to another ticket.',
    );
    if (field === 'request')
      result.value = canonicalPayload({ ...JSON.parse(row.value!), request: cold.request });
    else if (cold.batchSelection !== undefined) result.batchSelection = cold.batchSelection;
  }
  return result;
}

/** Present the unchanged logical row to all existing indexed readers. Cache only within this
 * transaction, and clone returned rows so caller edits cannot alter another reader's evidence. */
export function landingRequestBodies<C extends QueryCtx | MutationCtx>(ctx: C): C {
  const source = () => ctx.db;
  const raw = new Map<string, Row>();
  const bodies = new Map<string, Promise<unknown>>();
  const overrides = new Map<PropertyKey, unknown>();
  const bodyPort = new Proxy({} as Port, {
    get(_target, key) {
      if (key === 'get')
        return (id: string) => {
          let pending = bodies.get(id);
          if (!pending) bodies.set(id, (pending = source().get(id as never)));
          return pending;
        };
      const value = Reflect.get(source(), key);
      return typeof value === 'function' ? value.bind(source()) : value;
    },
  });
  const hydrate = async (row: Row | null) => {
    if (row?._id) raw.set(row._id, structuredClone(row));
    return hydrateLandingRequest(bodyPort, row);
  };
  const query = (target: object): unknown =>
    new Proxy(target, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === Symbol.asyncIterator)
          return async function* () {
            for await (const row of target as AsyncIterable<Row>) yield await hydrate(row);
          };
        if (typeof value !== 'function') return value;
        if (key === 'unique' || key === 'first')
          return async (...args: unknown[]) => hydrate(await value.apply(target, args));
        if (key === 'take' || key === 'collect')
          return async (...args: unknown[]) => Promise.all((await value.apply(target, args)).map(hydrate));
        if (key === 'paginate')
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            return { ...result, page: await Promise.all(result.page.map(hydrate)) };
          };
        return (...args: unknown[]) => query(value.apply(target, args));
      },
    });
  const split = async (value: Row, previous?: Row) => {
    const row = { ...value };
    const state = typeof row.value === 'string' ? JSON.parse(row.value) : null;
    const writer = source() as MutationCtx['db'];
    const save = async (pointer: string, field: string, content: unknown) => {
      const oldId = previous?.[pointer] ?? row[pointer];
      if (content === undefined) {
        if (oldId && pointer in row) row[pointer] = oldId;
        return;
      }
      const cold = {
        projectId: row.projectId ?? previous?.projectId,
        submissionId: row.submissionId ?? previous?.submissionId,
        [field]: content,
      };
      const text = canonicalPayload(cold);
      let id = typeof oldId === 'string' ? oldId : undefined;
      if (!id) id = await writer.insert('projectHostedLandingBodies', { value: text });
      else {
        const old = await bodyPort.get(id as never);
        invariant(old, 'SOURCE_UNAVAILABLE', 'The landing request body is unavailable.');
        const owner = JSON.parse((old as { value: string }).value);
        invariant(
          owner.projectId === cold.projectId && owner.submissionId === cold.submissionId,
          'EVIDENCE_CHANGED',
          'The landing request body belongs to another ticket.',
        );
        if ((old as { value: string }).value !== text)
          await writer.replace(id as Id<'projectHostedLandingBodies'>, { value: text });
      }
      bodies.set(id, Promise.resolve({ _id: id, value: text }));
      row[pointer] = id;
    };
    if (state?.request !== undefined) {
      await save('requestBodyId', 'request', state.request);
      delete state.request;
      row.value = canonicalPayload(state);
    }
    if ('batchSelection' in row) {
      if (row.batchSelection === undefined) {
        const id = previous?.selectionBodyId ?? row.selectionBodyId;
        if (typeof id === 'string') {
          await writer.delete(id as Id<'projectHostedLandingBodies'>);
          bodies.delete(id);
          row.selectionBodyId = undefined;
        }
      } else await save('selectionBodyId', 'batchSelection', row.batchSelection);
      row.batchSelection = undefined;
    }
    return row;
  };
  const db = new Proxy({} as C['db'], {
    has(_target, key) {
      return overrides.has(key) || Reflect.has(source(), key);
    },
    get(_target, key) {
      if (key === tag) return true;
      if (overrides.has(key)) return overrides.get(key);
      if (Reflect.get(source(), tag)) {
        const value = Reflect.get(source(), key);
        return typeof value === 'function' ? value.bind(source()) : value;
      }
      if (key === 'query')
        return (table: string) => {
          // oxlint-disable-next-line forge/convex-bounded-query -- transparent query port; callers retain their existing bounded index operations
          const selected = source().query(table as never);
          return table === 'projectHostedLandingRequests' ? query(selected) : selected;
        };
      if (key === 'get')
        return async (id: string) => {
          if (source().normalizeId?.('projectHostedLandingBodies', id)) return bodyPort.get(id as never);
          const row = await source().get(id as never);
          return source().normalizeId?.('projectHostedLandingRequests', id)
            ? hydrate(row as Row | null)
            : row;
        };
      if (key === 'insert')
        return async (table: string, value: Row) => {
          const writer = source() as MutationCtx['db'];
          if (table !== 'projectHostedLandingRequests') return writer.insert(table as never, value as never);
          const saved = await split(value);
          const id = await writer.insert('projectHostedLandingRequests', saved as never);
          raw.set(id, { ...saved, _id: id });
          return id;
        };
      if (key === 'patch' || key === 'replace' || key === 'delete')
        return async (id: string, value?: Row) => {
          const writer = source() as MutationCtx['db'];
          if (!writer.normalizeId?.('projectHostedLandingRequests', id))
            return key === 'delete'
              ? writer.delete(id as never)
              : key === 'patch'
                ? writer.patch(id as never, value as never)
                : writer.replace(id as never, value as never);
          const previous = raw.get(id) ?? ((await writer.get(id as never)) as Row | null);
          if (key === 'delete') {
            if (previous) await deleteLandingRequestBodies(writer, previous);
            await writer.delete(id as never);
            raw.delete(id);
            return;
          }
          const next = await split(value!, previous ?? undefined);
          if (key === 'patch') await writer.patch(id as never, next as never);
          else await writer.replace(id as never, next as never);
          raw.set(id, { ...(key === 'patch' ? previous : {}), ...next, _id: id });
        };
      const value = Reflect.get(source(), key);
      return typeof value === 'function' ? value.bind(source()) : value;
    },
    set(_target, key, value) {
      overrides.set(key, value);
      return true;
    },
  });
  originals.set(db, source);
  return new Proxy(ctx, {
    get(target, key, receiver) {
      return key === 'db' ? db : Reflect.get(target, key, receiver);
    },
  });
}
