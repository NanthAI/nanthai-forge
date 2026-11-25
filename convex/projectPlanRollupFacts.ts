// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closingChecklist } from '../src/planning-search';
import type { PlanningItem } from '../src/work-planning-types';
import type { RollupWork } from '../src/planning-rollup';
import { digest } from '../src/state/hash';
import { planningIntentHeads } from './projectPlanningIntentState';
import { openIntentLane } from './projectHostedOpenLaneEvidence';
import { recordHead } from './projectHostedRecords';
import { latestItemIntentHead } from './projectItemIntentHeads';
import { planItemOpenLaneMark, planLaneItem } from './projectPlanLaneMarks';
import { recordPartition } from './projectWorkIndexStore';
import { intentCompletionTime } from './projectPlanRollupReopen';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

export function rollupChecklist(body: string) {
  const { checked, open } = closingChecklist(body);
  return { checked, unchecked: open.length };
}

type Chain = Awaited<ReturnType<typeof planningIntentHeads>>;
type Lane = Awaited<ReturnType<typeof openIntentLane>>;
/** Only a finished mark pass proves the running-work tally. */
export const verifiedRollupMembership = (
  project: Doc<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) =>
  project.planLaneMarkCoverage?.generationId === generationId && project.planLaneMarkCoverage.cursor === null;

const pin = (head: Chain[number] | Lane) =>
  head ? [head.key, head.recordId, head.version, head.status] : null;

type Fact = { chain: Chain; mark: Awaited<ReturnType<typeof planItemOpenLaneMark>> };
type Item = Pick<PlanningItem, 'id' | 'kind' | 'status' | 'intentIds' | 'version' | 'statusPin'>;

/** A shared bounded reader per transaction; many Item links can name the same Item or Intent. */
export function rollupWorkReader(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  maxKeys: number,
) {
  const projectId = project._id;
  const verified = verifiedRollupMembership(project, generation._id);
  const partition = recordPartition(generation);
  const pending = new Map<string, Promise<Fact>>();
  const select = async (item: Item, id: string): Promise<Fact> => {
    if (!verified) return { chain: await planningIntentHeads(ctx, projectId, id), mark: null };
    const root = id === item.id ? item : await planLaneItem(ctx, project, id, false, partition);
    // The planning status writer moves the tally key atomically with the Item status.
    const [head, mark] = root
      ? await Promise.all([
          latestItemIntentHead(ctx, projectId, id),
          planItemOpenLaneMark(ctx, projectId, root),
        ])
      : [await recordHead(ctx, projectId, 'intent', id), null];
    return { chain: head ? [head] : [], mark };
  };
  const openByIntent = new Map<string, Promise<Lane>>();
  const completions = new Map<string, ReturnType<typeof intentCompletionTime>>();
  return {
    get calls() {
      return pending.size;
    },
    async read(item: Item) {
      const ids = item.kind === 'issue' ? [...new Set([item.id, ...(item.intentIds ?? [])])] : [];
      if (pending.size + ids.filter(id => !pending.has(id)).length > maxKeys)
        return { work: 'unknown' as const, workStamp: '' };
      const facts = await Promise.all(
        ids.map(id => {
          let read = pending.get(id);
          if (!read) pending.set(id, (read = select(item, id)));
          return read;
        }),
      );
      const chains = facts.map(fact => fact.chain);
      const marks = facts.map(fact => fact.mark);
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
        : marks.some(mark => (mark?.open ?? 0) > 0) || lanes.some(Boolean)
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
      let completedAt: number | undefined;
      if (
        work === 'completed' &&
        item.version > 1 &&
        !item.statusPin &&
        (item.status === 'open' || item.status === 'in-progress')
      ) {
        const dates = await Promise.all(
          chains.flatMap(chain => {
            const head = chain.at(-1);
            if (head?.status !== 'completed') return [];
            let read = completions.get(head.key);
            if (!read) completions.set(head.key, (read = intentCompletionTime(ctx, head)));
            return [read];
          }),
        );
        for (const at of dates)
          if (at !== undefined && (completedAt === undefined || at > completedAt)) completedAt = at;
      }
      return {
        work,
        completedAt,
        workStamp: digest(
          JSON.stringify([
            chains.map(chain => chain.map(pin)),
            lanes.map(pin),
            ...(verified ? [marks] : []),
            completedAt,
          ]),
        ),
      };
    },
  };
}
