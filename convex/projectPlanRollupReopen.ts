// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { splitRecordTable } from './projectWorkRecordTables';
import { hostedRecordBody, recordVersion } from './projectHostedRecords';
import { instant } from './projectPlanningTimes';
import type { PlanningItem } from '../src/work-planning-types';
import type { RollupWork } from '../src/planning-rollup';

const proofLimit = 8;

/** Legacy completed heads may have been copied (or revised for metadata) after the actual completion.
 * Prove the beginning of the current completed run, not the time of its newest record. */
export async function intentCompletionTime(ctx: QueryCtx, head: Doc<'projectHostedRecordHeads'>) {
  let known = await ctx.db.get(head.recordId);
  if (!known || known.status !== 'completed') return undefined;
  for (let i = 0; i < proofLimit && known.version > 0; i++) {
    const previous = await recordVersion(ctx, head.projectId, 'intent', head.key, known.version - 1);
    if (!previous) return undefined;
    if (previous.status !== 'completed') break;
    known = previous;
    if (i === proofLimit - 1 && known.version > 0) return undefined;
  }
  if (known.purged) return undefined;
  const { at: recordedAt, completionEvidenceAt } = JSON.parse(await hostedRecordBody(ctx, known));
  const at = instant(completionEvidenceAt ?? recordedAt);
  return Number.isFinite(at) ? at : undefined;
}

type Version = Pick<PlanningItem, 'id' | 'version' | 'status' | 'at' | 'was'> & {
  payload?: true;
  payloadKey?: string;
};
const terminal = (item: Version) =>
  [item.status, item.was].includes('closed') || [item.status, item.was].includes('abandoned');

/** No active/new-completion path scans history. On old completed work, read a bounded retained suffix.
 * If the suffix cannot prove closure safe, hold it until a new Work completion overtakes the latest put. */
export async function completionHeldByReopen(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  item: Version & Pick<PlanningItem, 'statusPin'>,
  { work, completedAt }: { work: RollupWork; completedAt?: number },
) {
  if (work !== 'completed' || item.statusPin || (item.status !== 'open' && item.status !== 'in-progress'))
    return false;
  const notNewer = (v: Version) => completedAt !== undefined && instant(v.at) <= completedAt;
  if (item.version <= 1 || notNewer(item)) return false;
  const rows = await ctx.db
    .query(splitRecordTable('planningVersions'))
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q.eq('generationId', partition).eq('collection', 'planningVersions').eq('parent', item.id),
    )
    .order('desc')
    .take(proofLimit + 1);
  const retained = new Map(
    rows.map(row => {
      const value: Version = JSON.parse(row.value);
      return [value.version, value];
    }),
  );
  let next = item;
  for (let n = 0; n < proofLimit; n++) {
    const version = next.version - 1;
    let previous = retained.get(version);
    if (!previous || previous.payload || previous.payloadKey) {
      // Records-mode writes do not keep every version in the old Plan partition.
      const row = await recordVersion(ctx, projectId, 'issue', item.id, version);
      previous = row && !row.purged ? JSON.parse(await hostedRecordBody(ctx, row)).item : undefined;
    }
    if (!previous || previous.id !== item.id || previous.version !== version) return true;
    if (!terminal(next) && terminal(previous)) return true;
    if (previous.version === 1 || notNewer(previous)) return false;
    next = previous;
  }
  return true;
}
