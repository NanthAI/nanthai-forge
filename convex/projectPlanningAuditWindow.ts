// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { diffPlanningVersion, type AuditChange } from '../src/planning-audit';
import type { PlanningItem } from '../src/work-planning-types';

const WINDOW = 32;
const ROW_BYTES = 4096;
type Pin = { version: number; operationId: string };
export type AuditVersion = Pin & {
  at: string;
  actor?: string;
  agent?: string;
  agentClient?: string;
  bodyAuthor?: string;
  statusSource?: 'work';
  summary: string;
  changes: AuditChange[];
};
type Stored = Omit<AuditVersion, 'version'> & { prev: Pin | null };

/** Both readers feed the same renderer, including its original author fallback. */
export function auditVersion(
  previous: PlanningItem | null,
  item: PlanningItem,
  actor?: string,
): AuditVersion {
  const bodyAuthor =
    item.version === 1 || (previous && previous.body !== item.body) ? item.author : undefined;
  const { summary, changes } = diffPlanningVersion(previous, item);
  return {
    operationId: item.operationId,
    version: item.version,
    at: item.at,
    ...(actor ? { actor } : {}),
    ...(item.agent === undefined ? {} : { agent: item.agent }),
    ...(item.agentClient === undefined ? {} : { agentClient: item.agentClient }),
    ...(bodyAuthor ? { bodyAuthor } : {}),
    ...(item.statusSource === 'work' ? { statusSource: item.statusSource } : {}),
    summary,
    changes,
  };
}

export async function retainAuditVersion(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  head: Pick<Doc<'projectHostedRecordHeads'>, 'version' | 'value'> | null,
  item: PlanningItem,
  actor?: string,
) {
  const { id: itemId, version } = item;
  if (item.purged || (head && head.version >= version)) return;
  if (version > WINDOW) {
    // Normally one expired row. After a gap, prune the bounded tail in the same range.
    const expired = await ctx.db
      .query('projectPlanningAudit')
      .withIndex('by_project_and_item_and_version', q =>
        q
          .eq('projectId', projectId)
          .eq('itemId', itemId)
          .lte('version', version - WINDOW),
      )
      .take(WINDOW);
    for (const old of expired) await ctx.db.delete(old._id);
  }
  let previous: PlanningItem | null = null;
  if (head) {
    if (item.previousVersion !== head.version || version !== head.version + 1 || !head.value) return;
    previous = JSON.parse(head.value) as PlanningItem;
    if (
      previous.id !== itemId ||
      previous.version !== head.version ||
      previous.purged ||
      !previous.operationId
    )
      return;
  } else if (version !== 1) return;
  const { version: summaryVersion, ...inputs } = auditVersion(previous, item, actor);
  const prev = previous ? { version: previous.version, operationId: previous.operationId } : null;
  const row = {
    projectId,
    itemId,
    version: summaryVersion,
    value: JSON.stringify({ ...inputs, prev } satisfies Stored),
  };
  if (getDocumentSize({ ...row, _id: 'x'.repeat(32), _creationTime: 0 }) <= ROW_BYTES)
    await ctx.db.insert('projectPlanningAudit', row);
}

/** The authoritative head pins even a cursor page. An unproved prefix leaves the exact reader's budget intact. */
export async function auditPrefix(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  current: Pick<PlanningItem, 'id' | 'version' | 'operationId'>,
  from: number,
  limit: number,
  remainingBytes: number,
): Promise<{ versions: AuditVersion[]; more: boolean; bytes: number } | null> {
  const to = Math.min(from, current.version);
  const needed = Math.min(to, limit + 1);
  if (current.version - to + needed > WINDOW || remainingBytes <= 0) return null;
  const rows = ctx.db
    .query('projectPlanningAudit')
    .withIndex('by_project_and_item_and_version', q =>
      q.eq('projectId', projectId).eq('itemId', current.id).lte('version', current.version),
    )
    .order('desc');
  let pin: Pin | null = current;
  let bytes = 0;
  const versions: AuditVersion[] = [];
  for await (const row of rows) {
    bytes += getDocumentSize(row);
    if (bytes > remainingBytes || row.version !== pin?.version) return null;
    const { prev, ...data } = JSON.parse(row.value) as Stored;
    if (data.operationId !== pin.operationId) return null;
    if (row.version === 1 ? prev !== null : prev?.version !== row.version - 1 || !prev.operationId)
      return null;
    pin = prev;
    if (row.version > to) continue;
    versions.push({ version: row.version, ...data });
    if (versions.length !== needed) continue;
    if (needed > limit) versions.pop();
    return { versions, more: to > versions.length, bytes };
  }
  return null;
}

/** A decision rewrite can change both its own summary and the next version's predecessor diff. */
export async function clearAuditVersions(ctx: MutationCtx, projectId: Id<'hostedProjects'>, itemId: string) {
  // Start each page at the prefix: the previous page has been deleted in this transaction.
  // Exceeding the provider transaction budget rolls back the purge rather than leaving excerpts.
  for (;;) {
    const rows = await ctx.db
      .query('projectPlanningAudit')
      .withIndex('by_project_and_item_and_version', q => q.eq('projectId', projectId).eq('itemId', itemId))
      .take(WINDOW + 1);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length < WINDOW + 1) return;
  }
}
