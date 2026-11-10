// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { metricReadProjection, metricRunKind } from './projectMetricReadProjection';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';

/** Reuse canonical rows the mutation already read. The compact row's identity/digest ride on
 * the canonical write, so upkeep needs neither another lookup nor a status-observer change. */
export function metricReadWriter(db: MutationCtx['db']) {
  const rows = new Map<string, Doc<'projectHostedCheckRuns'>>();
  const written = new Set<string>();
  const remember = (value: unknown) => {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(remember);
      else if ('page' in value) remember(value.page);
      else if ('_id' in value && typeof value._id === 'string' && !written.has(value._id))
        rows.set(value._id, value as Doc<'projectHostedCheckRuns'>);
    }
    return value;
  };
  const finalizers = new Set(['unique', 'first', 'take', 'paginate', 'collect']);
  const tracked = <T extends object>(query: T): T =>
    new Proxy(query, {
      get(target, key, receiver) {
        const method = Reflect.get(target, key, receiver);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          if (finalizers.has(String(key))) return Promise.resolve(result).then(remember);
          return result && typeof result === 'object' ? tracked(result) : result;
        };
      },
    });
  return {
    query: <TableName extends Parameters<MutationCtx['db']['query']>[0]>(table: TableName) => {
      // oxlint-disable-next-line forge/convex-bounded-query -- pass-through: bounded chains remain at caller sites
      const query = db.query(table);
      return table === 'projectHostedCheckRuns' ? tracked(query) : query;
    },
    get: (async (id: string) => {
      const value = await db.get(id as never);
      if (
        value &&
        typeof value === 'object' &&
        'runId' in value &&
        'candidateId' in value &&
        'value' in value
      )
        remember(value);
      return value;
    }) as MutationCtx['db']['get'],
    async write(id: string, kind: 'patch' | 'replace' | 'delete', value?: Record<string, unknown>) {
      const old = rows.get(id);
      written.add(id);
      // A full-value write without a prior source read must remain zero-read. Invalidate
      // compact coverage; the canonical reader retains every measure until a normal update.
      if (!old) {
        if (kind === 'delete' || kind === 'replace' || 'projectId' in value! || 'runId' in value!) {
          const stale = await db
            .query('projectFinishReadRows')
            .withIndex('by_kind_and_source', q => q.eq('kind', metricRunKind).eq('sourceId', id))
            .unique();
          if (stale) await db.delete(stale._id);
          return kind === 'delete'
            ? value
            : { ...value, metricsProjected: undefined, metricProjection: undefined };
        }
        return 'value' in value! ? { ...value, metricsProjected: undefined } : value;
      }
      const retained = old?.metricProjection;
      if (kind === 'delete') {
        if (retained) await db.delete(retained.rowId);
        rows.delete(id);
        return value;
      }
      const source =
        kind === 'replace'
          ? { ...value, _id: id, _creationTime: old?._creationTime }
          : { ...old, ...value, _id: id };
      const projection = metricReadProjection(source);
      if (!projection) {
        if (retained) await db.delete(retained.rowId);
        rows.delete(id);
        return { ...value, metricsProjected: undefined, metricProjection: undefined };
      }
      const hash = digest(canonicalPayload(projection));
      const rowId = retained?.rowId ?? (await db.insert('projectFinishReadRows', projection as never));
      if (retained && retained.digest !== hash) await db.replace(rowId, projection as never);
      const fields = { metricsProjected: true as const, metricProjection: { rowId, digest: hash } };
      rows.set(id, { ...source, ...fields } as Doc<'projectHostedCheckRuns'>);
      return { ...value, ...fields };
    },
  };
}
