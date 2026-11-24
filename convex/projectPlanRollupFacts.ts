// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closingChecklist } from '../src/planning-search';
import type { PlanningItem } from '../src/work-planning-types';
import type { RollupWork } from '../src/planning-rollup';
import { digest } from '../src/state/hash';
import { planningIntentHeads } from './projectPlanningIntentState';
import { openIntentLane } from './projectHostedOpenLaneEvidence';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export function rollupChecklist(body: string) {
  const { checked, open } = closingChecklist(body);
  return { checked, unchecked: open.length };
}

type Chain = Awaited<ReturnType<typeof planningIntentHeads>>;
type Lane = Awaited<ReturnType<typeof openIntentLane>>;
const pin = (head: Chain[number] | Lane) =>
  head ? [head.key, head.recordId, head.version, head.status] : null;

/** A shared bounded reader per transaction; many Item links can name the same Intent head. */
export function rollupWorkReader(ctx: QueryCtx, projectId: Id<'hostedProjects'>, maxKeys: number) {
  const pending = new Map<string, Promise<Chain>>();
  const openByIntent = new Map<string, Promise<Lane>>();
  return {
    get calls() {
      return pending.size;
    },
    async read(item: Pick<PlanningItem, 'id' | 'kind' | 'intentIds'>) {
      const ids = item.kind === 'issue' ? [...new Set([item.id, ...(item.intentIds ?? [])])] : [];
      if (pending.size + ids.filter(id => !pending.has(id)).length > maxKeys)
        return { work: 'unknown' as const, workStamp: '' };
      const chains = await Promise.all(
        ids.map(id => {
          let read = pending.get(id);
          if (!read) pending.set(id, (read = planningIntentHeads(ctx, projectId, id)));
          return read;
        }),
      );
      const live = chains.flatMap(chain => {
        const head = chain.at(-1);
        return head && !head.status.startsWith('journal:') ? [head.status] : [];
      });
      const keys = new Set(
        chains
          .flat()
          .filter(head => !head.status.startsWith('journal:'))
          .map(head => head.key),
      );
      const lanes = await Promise.all(
        [...keys].map(key => {
          let read = openByIntent.get(key);
          if (!read && openByIntent.size < maxKeys)
            openByIntent.set(key, (read = openIntentLane(ctx, projectId, key)));
          return read;
        }),
      );
      const work: RollupWork = chains.some(
        (chain, i) => !chain.length && (i > 0 || item.intentIds?.includes(item.id)),
      )
        ? 'unknown'
        : lanes.some(Boolean)
          ? 'active'
          : lanes.includes(undefined)
            ? 'unknown'
            : live.includes('active')
              ? 'abandoned' // No open Lane; do not infer successful work or auto-close from stale active state.
              : live.includes('completed')
                ? 'completed'
                : live.length
                  ? 'abandoned'
                  : 'none';
      return {
        work,
        workStamp: digest(JSON.stringify([chains.map(chain => chain.map(pin)), lanes.map(pin)])),
      };
    },
  };
}
