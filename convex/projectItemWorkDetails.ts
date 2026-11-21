// SPDX-License-Identifier: Apache-2.0
// Optional Item-page facts. These reads share the Item Work transaction and its page; the CLI keeps its compact reply.
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedRecord } from '../src/hosted-records';
import { LANDINGS_READ_BYTES } from '../src/hosted-landings-view';
import type { PlanningItem } from '../src/work-planning-types';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { hostedRecordBody, readHostedRecord, recordVersion } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

type ReadIdentity = { projectId: Id<'hostedProjects'>; actor: string };
type Link = { kind: string; id: string; title: string };
type Preview = Pick<
  PlanningItem,
  'id' | 'title' | 'kind' | 'initiativeId' | 'parentId' | 'relations' | 'status' | 'body' | 'purged'
>;
const SAVES_COUNTED = 50;

export async function itemWorkLaneDetails(
  ctx: QueryCtx,
  identity: ReadIdentity,
  lanes: readonly { id: string; intentId: string }[],
) {
  const titles = new Map(
    [...new Set(lanes.map(lane => lane.intentId))].map(intentId => [
      intentId,
      readHostedRecord(ctx, { ...identity, kind: 'intent', key: intentId }).then(
        row => (row ? (JSON.parse(row.value) as { outcome?: string }).outcome : undefined) ?? null,
      ),
    ]),
  );
  return new Map(
    await Promise.all(
      lanes.map(async lane => {
        const [title, saves] = await Promise.all([
          titles.get(lane.intentId),
          ctx.db
            .query('projectHostedRecordHeads')
            .withIndex('by_project_and_kind_and_parent', q =>
              q.eq('projectId', identity.projectId).eq('kind', 'save').eq('parent', lane.id),
            )
            .order('desc')
            .take(SAVES_COUNTED + 1),
        ]);
        const newest = saves[0] ? await ctx.db.get(saves[0].recordId) : null;
        const lastSaveAt = newest
          ? (JSON.parse(await hostedRecordBody(ctx, newest)) as { at: string }).at
          : null;
        return [
          lane.id,
          {
            title: title ?? null,
            saveCount: Math.min(saves.length, SAVES_COUNTED),
            moreSaves: saves.length > SAVES_COUNTED,
            lastSaveAt,
          },
        ] as const;
      }),
    ),
  );
}

export async function itemWorkLandingDetails<T extends { receiptId: string; commit: string }>(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  landings: T[],
) {
  const receipts = await Promise.all(
    landings.map(async landing => {
      const row = await acceptanceRow(ctx, { projectId, receiptId: landing.receiptId });
      const receipt = row ? (JSON.parse(row.value) as HostedAcceptance) : null;
      return receipt?.candidate.head === landing.commit ? receipt : null;
    }),
  );
  const keys = new Set(receipts.flatMap(receipt => (receipt ? [receipt.candidate.id] : [])));
  const versions = await Promise.all([...keys].map(id => recordVersion(ctx, projectId, 'candidate', id, 0)));
  // A cohort can share a Candidate across many receipts. Hydrate it once and reuse
  // the existing landing-evidence byte budget for the page's combined Candidate bodies.
  let remaining = LANDINGS_READ_BYTES;
  const candidates = new Map<string, Promise<Extract<HostedRecord, { kind: 'candidate' }>>>();
  for (const row of versions) {
    if (!row || row.bytes > remaining) continue;
    remaining -= row.bytes;
    candidates.set(
      row.key,
      hostedRecordBody(ctx, row).then(value => JSON.parse(value)),
    );
  }
  return Promise.all(
    landings.map(async (landing, index) => {
      const receipt = receipts[index];
      const candidate = receipt && (await candidates.get(receipt.candidate.id));
      const paths =
        candidate?.result.status === 'clean' && candidate.result.head === landing.commit
          ? candidate.governance?.paths
          : null;
      return {
        ...landing,
        check: receipt ? (receipt.check ? ('passed' as const) : ('not-checked' as const)) : null,
        files: paths?.length ?? null,
      };
    }),
  );
}

export async function itemWorkRelated(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
  owner: boolean,
): Promise<Link[]> {
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return [];
  const partition = recordPartition(generation);
  const load = async (id: string, collection = 'planningItems') => {
    const found = await record(ctx, partition, collection, id);
    const row = found && (JSON.parse(found.value) as Preview);
    if (!row || row.purged || (!owner && (row.status === 'archived' || row.status === 'deleted')))
      return null;
    return row;
  };
  const item = await load(itemId, 'planningSearch');
  if (!item) return [];
  const links = new Map<string, Link>();
  const add = (kind: string, row: Preview) =>
    links.set(`${kind}:${row.id}`, { kind, id: row.id, title: row.title });
  const refs = new Set([
    ...(item.initiativeId ? [item.initiativeId] : []),
    ...(item.parentId ? [item.parentId] : []),
    ...(item.relations ?? []).map(relation => relation.id),
  ]);
  const found = new Map(await Promise.all([...refs].map(async id => [id, await load(id)] as const)));
  const initiative = item.initiativeId && found.get(item.initiativeId);
  if (initiative) add('Initiative', initiative);
  const parent = item.parentId && found.get(item.parentId);
  if (parent) add('Parent', parent);
  const splitFrom = (row: Preview, id: string) => row.body?.startsWith(`Split from ${id.slice(0, 8)}.\n`);
  for (const relation of item.relations ?? []) {
    const other = found.get(relation.id);
    if (!other) continue;
    if (relation.kind === 'depends-on') add('Depends on', other);
    if (relation.kind === 'duplicate-of') add('Duplicate of', other);
    if (relation.kind === 'related') {
      add(
        splitFrom(item, other.id) ? 'Split from' : splitFrom(other, itemId) ? 'Split into' : 'Related',
        other,
      );
    }
    if (other.relations?.some(link => link.kind === 'depends-on' && link.id === itemId)) add('Blocks', other);
  }
  return [...links.values()];
}
