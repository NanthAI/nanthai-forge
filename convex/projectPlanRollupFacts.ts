// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closingChecklist } from '../src/planning-search';
import type { PlanningItem } from '../src/work-planning-types';
import type { RollupWork } from '../src/planning-rollup';
import { digest } from '../src/state/hash';
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

type Intent = Doc<'projectHostedRecordHeads'> | null;
type Lane = Awaited<ReturnType<typeof openIntentLane>>;
/** Only a finished mark pass proves the running-work tally. */
export const verifiedRollupMembership = (
  project: Doc<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) =>
  project.planLaneMarkCoverage?.generationId === generationId && project.planLaneMarkCoverage.cursor === null;

const pin = (head: Intent | Lane) => (head ? [head.key, head.recordId, head.version, head.status] : null);

type Fact = { head: Intent; mark: Awaited<ReturnType<typeof planItemOpenLaneMark>> };
type Item = Pick<PlanningItem, 'id' | 'kind' | 'status' | 'intentIds' | 'version' | 'statusPin'>;

/** A shared bounded reader per transaction; many Item links can name the same Item or Intent. */
export function rollupWorkReader(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  maxKeys: number,
) {
  const projectId = project._id;
  const partition = recordPartition(generation);
  const pending = new Map<string, Promise<Fact>>();
  const select = async (item: Item, id: string): Promise<Fact> => {
    const root = id === item.id ? item : await planLaneItem(ctx, project, id, false, partition);
    // The planning status writer moves the tally key atomically with the Item status.
    const [head, mark] = root
      ? await Promise.all([
          latestItemIntentHead(ctx, projectId, id),
          planItemOpenLaneMark(ctx, projectId, root),
        ])
      : [await recordHead(ctx, projectId, 'intent', id), null];
    return { head, mark };
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
      const heads = facts.map(fact => fact.head);
      const marks = facts.map(fact => fact.mark);
      const live = heads.filter(
        (head): head is NonNullable<Intent> => head !== null && !head.status.startsWith('journal:'),
      );
      const keys = new Set(live.map(head => head.key));
      const lanes = await Promise.all(
        [...keys].map(key => {
          let read = openByIntent.get(key);
          if (!read && openByIntent.size < maxKeys)
            openByIntent.set(key, (read = openIntentLane(ctx, projectId, key)));
          return read;
        }),
      );
      const work: RollupWork = heads.some((head, i) => !head && (i > 0 || item.intentIds?.includes(item.id)))
        ? 'unknown'
        : marks.some(mark => (mark?.open ?? 0) > 0) || lanes.some(Boolean)
          ? 'active'
          : lanes.includes(undefined)
            ? 'unknown'
            : live.some(head => head?.status === 'active')
              ? 'abandoned' // No open Lane; do not infer successful work or auto-close from stale active state.
              : live.some(head => head?.status === 'completed')
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
          heads.flatMap(head => {
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
          JSON.stringify([heads.map(head => (head ? [pin(head)] : [])), lanes.map(pin), marks, completedAt]),
        ),
      };
    },
  };
}
