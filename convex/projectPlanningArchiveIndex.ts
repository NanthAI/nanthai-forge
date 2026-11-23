// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { digest } from '../src/state/hash';
import { purgeableRowTarget } from '../src/work-planning-purge';
import { invariant } from '../src/errors';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { receiptRow } from './projectJournalMaintenance';

export const archiveIndexKind = v.union(
  v.literal('events'),
  v.literal('intent'),
  v.literal('issue'),
  v.literal('comment'),
  v.literal('lifecycle'),
);
type Kind = typeof archiveIndexKind.type;
export type ArchiveTarget = { kind: Kind; itemId: string };
type Project = Id<'hostedProjects'>;
export const archiveIndexPageSize = 16;

export function archivedEventItem(operationId: string, command: { action?: string }) {
  switch (command.action) {
    case 'intent':
    case 'note':
    case 'put-planning-item':
    case 'comment-planning-item':
      return purgeableRowTarget(operationId, command)?.id;
  }
}

export function archivedRecordTarget(row: Pick<Doc<'projectHostedRecords'>, 'kind' | 'key' | 'parent'>) {
  switch (row.kind) {
    case 'intent':
    case 'issue':
      return { kind: row.kind, itemId: row.key };
    case 'comment':
    case 'lifecycle':
      return { kind: row.kind, itemId: row.parent };
  }
}

// The existing receipt index holds sparse references only for archives whose original lookup
// keys have been stripped. A reference names the stable segment key, even after a rewrite.
const prefix = ({ kind, itemId }: ArchiveTarget) => `planning-archive:${kind}:${digest(itemId)}:`;
export async function indexArchiveTargets(
  ctx: MutationCtx,
  projectId: Project,
  key: string,
  targets: readonly ArchiveTarget[],
) {
  for (const operationId of new Set(targets.map(target => prefix(target) + key))) {
    if (!(await receiptRow(ctx, projectId, operationId)))
      await ctx.db.insert('projectJournalReceipts', { projectId, operationId, hash: key, envelope: '' });
  }
}

export const archiveSegmentRow = (ctx: QueryCtx, projectId: Project, key: string) =>
  ctx.db
    .query('projectJournalSegments')
    .withIndex('by_project_and_key', q => q.eq('projectId', projectId).eq('key', key))
    .unique();

export async function archivedSegmentRows(ctx: QueryCtx, projectId: Project, keys: string[]) {
  return Promise.all(
    [...new Set(keys)].map(async key => {
      const row = await archiveSegmentRow(ctx, projectId, key);
      invariant(row, 'SOURCE_UNAVAILABLE', 'An indexed Item journal segment is unavailable.');
      return row;
    }),
  );
}

async function archiveTargetKeys(
  ctx: QueryCtx,
  projectId: Project,
  target: ArchiveTarget,
  after: string | null,
  limit: number,
) {
  const start = prefix(target);
  const rows = await ctx.db
    .query('projectJournalReceipts')
    .withIndex('by_project_and_operation', q =>
      q
        .eq('projectId', projectId)
        .gt('operationId', start + (after ?? ''))
        .lt('operationId', start + '~'),
    )
    .take(limit);
  return rows.map(row => row.hash);
}

export const archiveTargetCursor = v.object({ target: v.number(), after: v.union(v.string(), v.null()) });
export type TargetCursor = typeof archiveTargetCursor.type;

/** A bounded range walk, including aliases with no archive. Selection stays within one nonempty target. */
export async function archivedTargetPage(
  ctx: QueryCtx,
  projectId: Project,
  targets: readonly ArchiveTarget[],
  cursor: TargetCursor,
  combine = false,
) {
  let { target, after } = cursor;
  let matched = target;
  let itemId: string | null = null;
  const keys: string[] = [];
  for (let ranges = 0; ranges < archiveIndexPageSize && target < targets.length; ranges++) {
    const selected = targets[target]!;
    const limit = archiveIndexPageSize - keys.length;
    const batch = await archiveTargetKeys(ctx, projectId, selected, after, limit);
    if (batch.length) {
      matched = target;
      itemId = selected.itemId;
      keys.push(...batch);
    }
    if (batch.length === limit) {
      after = batch.at(-1)!;
      break;
    }
    target++;
    after = null;
    if (batch.length && !combine) break;
  }
  return { keys, itemId, target: matched, next: { target, after }, done: target === targets.length };
}
