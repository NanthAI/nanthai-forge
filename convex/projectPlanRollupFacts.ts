// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closingChecklist } from '../src/planning-search';
import type { PlanningItem } from '../src/work-planning-types';
import type { RollupWork } from '../src/planning-rollup';
import { digest } from '../src/state/hash';
import { currentPlanningIntentHead } from './projectPlanningIntentState';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export function rollupChecklist(body: string) {
  const { checked, open } = closingChecklist(body);
  return { checked, unchecked: open.length };
}

type Head = Awaited<ReturnType<typeof currentPlanningIntentHead>>;

export const rollupWorkStamp = (heads: readonly Head[]) =>
  digest(
    JSON.stringify(heads.map(head => (head ? [head.key, head.recordId, head.version, head.status] : null))),
  );

/** A shared bounded reader per transaction; many Item links can name the same Intent head. */
export function rollupWorkReader(ctx: QueryCtx, projectId: Id<'hostedProjects'>, maxKeys: number) {
  const pending = new Map<string, Promise<Head>>();
  return {
    get calls() {
      return pending.size;
    },
    async read(item: Pick<PlanningItem, 'id' | 'kind' | 'intentIds'>) {
      const ids = item.kind === 'issue' ? [...new Set([item.id, ...(item.intentIds ?? [])])] : [];
      if (pending.size + ids.filter(id => !pending.has(id)).length > maxKeys)
        return { work: 'unknown' as const, heads: [] };
      const heads = await Promise.all(
        ids.map(id => {
          let read = pending.get(id);
          if (!read) pending.set(id, (read = currentPlanningIntentHead(ctx, projectId, id)));
          return read;
        }),
      );
      const live = heads.flatMap(head => (head && !head.status.startsWith('journal:') ? [head.status] : []));
      const work: RollupWork = heads.some((head, i) => !head && (i > 0 || item.intentIds?.includes(item.id)))
        ? 'unknown'
        : live.some(status => status !== 'completed' && status !== 'abandoned')
          ? 'active'
          : live.includes('completed')
            ? 'completed'
            : live.length
              ? 'abandoned'
              : 'none';
      return { work, heads };
    },
  };
}
