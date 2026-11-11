// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { JournalRunInput } from './projectJournalMaintenance';
export function journalEligibilityKey(operationId: string) {
  const at = /^eligibility:.*:(\d+)$/.exec(operationId)?.[1];
  return at ? `journal-wake:${at.padStart(16, '0')}:${digest(operationId)}` : null;
}
export const journalGraceMs = 7 * 86_400_000;
export async function wakeJournal(ctx: MutationCtx, input: JournalRunInput, dueAt: number) {
  if (process.env.FORGE_JOURNAL_SEGMENTS !== '1') return;
  const operationId = journalEligibilityKey(input.operationId);
  if (operationId) {
    const old = await ctx.db
      .query('projectJournalReceipts')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', operationId),
      )
      .unique();
    if (old) return;
    const envelope = canonicalPayload(input);
    await ctx.db.insert('projectJournalReceipts', {
      projectId: input.projectId,
      operationId,
      hash: digest(envelope),
      envelope,
    });
  }
  await ctx.scheduler.runAfter(
    Math.max(0, dueAt - Date.now()),
    makeFunctionReference<'action'>('projectJournalRun:pack'),
    input,
  );
}
/** Attached to the existing supersession write; no added RPC and no idle wake. */
export async function readyJournalRecord(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  id: Id<'projectHostedRecords'>,
) {
  if (process.env.FORGE_JOURNAL_SEGMENTS !== '1') return;
  void projectId;
  await ctx.db.patch(id, { journalReadyAt: Date.now() + journalGraceMs });
}

/** A late ledger update changes the recovery snapshot even while new relocation is disabled. */
export async function retainJournalRecovery(
  ctx: MutationCtx,
  row: {
    _id: Id<'projectHostedOperations'>;
    projectId: Id<'hostedProjects'>;
    journalSegment?: string;
    recovery?: string;
  },
  recovery: string,
) {
  if (row.recovery === recovery) return;
  await ctx.db.patch(row._id, { recovery, ...(row.journalSegment ? { journalReadyAt: Date.now() } : {}) });
  if (!row.journalSegment) return;
  const project = await ctx.db.get(row.projectId);
  if (project) await ctx.db.patch(project._id, { journalRevision: (project.journalRevision ?? 0) + 1 });
  await wakeJournal(
    ctx,
    { projectId: row.projectId, operationId: `recovery:${row._id}:${digest(recovery)}`, phase: 1 },
    Date.now(),
  );
}
