// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Optional Item-page facts. These reads share the Item Work transaction and its page; the CLI keeps its compact reply.
import { getDocumentSize } from 'convex/values';
import { inverseRelationLabel, isLive } from '../src/planning-model';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedRecord } from '../src/hosted-records';
import { LANDINGS_READ_BYTES } from '../src/hosted-landings-view';
import type { PlanningItem } from '../src/work-planning-types';
import { invariant } from '../src/errors';
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

export const landingFileCandidate = (receipt: HostedAcceptance, memberFiles: boolean) =>
  (memberFiles ? receipt.memberCandidate : undefined) ?? receipt.candidate;

export const candidateLandingPaths = (
  candidate: Extract<HostedRecord, { kind: 'candidate' }> | undefined,
  head: string | null | undefined,
) =>
  candidate?.result.status === 'clean' && candidate.result.head === head
    ? (candidate.governance?.paths ?? null)
    : null;

export async function itemWorkLandingDetails<T extends { receiptId: string; commit: string }>(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  landings: T[],
  memberFiles = false,
) {
  const receipts = await Promise.all(
    landings.map(async landing => {
      const row = await acceptanceRow(ctx, { projectId, receiptId: landing.receiptId });
      const receipt = row ? (JSON.parse(row.value) as HostedAcceptance) : null;
      return receipt?.candidate.head === landing.commit ? receipt : null;
    }),
  );
  const fileCandidate = (receipt: HostedAcceptance) => landingFileCandidate(receipt, memberFiles);
  const keys = new Set(receipts.flatMap(receipt => (receipt ? [fileCandidate(receipt).id] : [])));
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
      const source = receipt && fileCandidate(receipt);
      const candidate = source && (await candidates.get(source.id));
      return {
        ...landing,
        check: receipt ? (receipt.check ? ('passed' as const) : ('not-checked' as const)) : null,
        paths: candidateLandingPaths(candidate || undefined, source?.head),
      };
    }),
  );
}

/** Work uses a position cursor over planning roots. Read one page and at most
 * one lookahead row, and admit a valid oversized root when it starts the page. */
export async function planningWorkPage(rows: AsyncIterable<Doc<'projectPlanningRecords'>>, limit: number) {
  const page: Doc<'projectPlanningRecords'>[] = [];
  let bytes = 0;
  for await (const row of rows) {
    const size = getDocumentSize(row);
    if (page.length === limit || (page.length && bytes + size > 128 * 1024)) return { page, more: true };
    page.push(row);
    bytes += size;
  }
  return { page, more: false };
}

function allowedWorkItem(row: Preview, owner: boolean) {
  return !row.purged && (owner || (row.status !== 'archived' && row.status !== 'deleted'));
}

async function workItem(ctx: QueryCtx, partition: Id<'projectWorkGenerations'>, id: string, owner: boolean) {
  const found =
    (await record(ctx, partition, 'planningSearch', id)) ??
    (await record(ctx, partition, 'planningItems', id));
  const row = found && (JSON.parse(found.value) as Preview);
  return row && allowedWorkItem(row, owner) ? row : null;
}

type ItemWorkPlan = { item: Preview; partition: Id<'projectWorkGenerations'>; owner: boolean };

export async function visibleItemWork(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
  owner: boolean,
): Promise<ItemWorkPlan | null> {
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return null;
  const partition = recordPartition(generation);
  const item = await workItem(ctx, partition, itemId, owner);
  return item?.kind === 'issue' ? { item, partition, owner } : null;
}

export async function itemWorkRelated(
  ctx: QueryCtx,
  { item, partition, owner }: ItemWorkPlan,
  cursor: string | null,
) {
  const itemId = item.id;
  const separator = cursor?.indexOf(':') ?? -1;
  const position = cursor === null ? undefined : Number(cursor.slice(separator + 1));
  invariant(
    cursor === null ||
      (separator > 0 &&
        cursor.slice(0, separator) === partition &&
        Number.isSafeInteger(position) &&
        position! >= 0),
    'WORK_STALE',
    'The plan changed. Reopen this Item to read its related work.',
  );
  const links = new Map<string, Link>();
  const add = (kind: string, row: Preview) =>
    links.set(`${kind}:${row.id}`, { kind, id: row.id, title: row.title });
  const splitFrom = (row: Preview, id: string) => row.body?.startsWith(`Split from ${id.slice(0, 8)}.\n`);
  const relatedLabel = (other: Preview) =>
    splitFrom(item, other.id) ? 'Split from' : splitFrom(other, itemId) ? 'Split into' : 'Related';
  const inbound = (other: Preview) => {
    for (const relation of other.relations ?? []) {
      if (relation.id !== itemId) continue;
      add(relation.kind === 'related' ? relatedLabel(other) : inverseRelationLabel[relation.kind], other);
    }
  };
  if (cursor === null) {
    const refs = new Set([
      ...(item.initiativeId ? [item.initiativeId] : []),
      ...(item.parentId ? [item.parentId] : []),
      ...(item.relations ?? []).map(relation => relation.id),
    ]);
    const found = new Map(
      await Promise.all([...refs].map(async id => [id, await workItem(ctx, partition, id, owner)] as const)),
    );
    const initiative = item.initiativeId && found.get(item.initiativeId);
    if (initiative) add('Initiative', initiative);
    const parent = item.parentId && found.get(item.parentId);
    if (parent && (!isLive(item) || isLive(parent))) add('Parent', parent);
    for (const relation of item.relations ?? []) {
      const other = found.get(relation.id);
      if (!other) continue;
      if (relation.kind === 'depends-on') add('Depends on', other);
      if (relation.kind === 'duplicate-of') add('Duplicate of', other);
      if (relation.kind === 'related') add(relatedLabel(other), other);
      inbound(other);
    }
  }
  // Reverse links use the current projection, including settled Items and old relations.
  // Bound the indexed page by rows and stored bytes rather than loading the board.
  const reverse = await planningWorkPage(
    ctx.db
      .query('projectPlanningRecords')
      .withIndex('by_planning_kind', q => {
        const range = q
          .eq('generationId', partition)
          .eq('collection', 'planningSearch')
          .eq('planning.kind', 'issue');
        return position === undefined ? range : range.lt('position', position);
      })
      .order('desc'),
    50,
  );
  for (const row of reverse.page) {
    const other = JSON.parse(row.value) as Preview;
    if (other.id !== itemId && allowedWorkItem(other, owner)) inbound(other);
  }
  return {
    links: [...links.values()],
    next: reverse.more ? `${partition}:${reverse.page.at(-1)!.position}` : null,
  };
}
