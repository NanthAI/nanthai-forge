// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { receiptRow } from './projectJournalMaintenance';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';

const key = 'journal-archive-state';
type State = { revision: number; recordReceipts?: true };
type Legacy = Pick<Doc<'hostedProjects'>, 'journalRevision' | 'journalRecordReceipts'>;

async function storedJournalState(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const row = await receiptRow(ctx, projectId, key);
  const state: State = row ? JSON.parse(row.envelope) : { revision: 0 };
  return { row, state };
}

/** Keep the legacy counter as a base so an export can still validate its original pin.
 * Live views never read the changing archive fence. */
export async function journalState(ctx: QueryCtx, projectId: Id<'hostedProjects'>, legacy?: Legacy | null) {
  const { state } = await storedJournalState(ctx, projectId);
  return {
    revision: (legacy?.journalRevision ?? 0) + state.revision,
    recordReceipts: state.recordReceipts || legacy?.journalRecordReceipts,
  };
}

export async function bumpJournalState(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  recordReceipts?: true,
) {
  const { row, state } = await storedJournalState(ctx, projectId);
  const envelope = canonicalPayload({
    revision: state.revision + 1,
    ...((recordReceipts || state.recordReceipts) && { recordReceipts: true }),
  });
  const fields = { projectId, operationId: key, envelope, hash: digest(envelope) };
  if (row) await ctx.db.replace(row._id, fields);
  else await ctx.db.insert('projectJournalReceipts', fields);
}
