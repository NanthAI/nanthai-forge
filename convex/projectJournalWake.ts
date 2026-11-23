// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { receiptRow, type JournalRunInput } from './projectJournalMaintenance';
import { cancelPendingTask } from './schedulerCancel';
export function journalEligibilityKey(operationId: string) {
  const at = /^eligibility:.*:(\d+)$/.exec(operationId)?.[1];
  return at ? `journal-wake:${at.padStart(16, '0')}:${digest(operationId)}` : null;
}
export const journalGraceMs = 7 * 86_400_000;
/** Live wakes coalesce into one drain per project per hour: the grace is a minimum age, so an hour
 * later costs nothing, and a burst of writes leaves one scheduled pack, not one per write. */
export const journalDrainBucketMs = 3_600_000;
const drainPointer = 'journal-next';
export async function wakeJournal(ctx: MutationCtx, input: JournalRunInput, dueAt: number) {
  if (process.env.FORGE_JOURNAL_SEGMENTS !== '1') return;
  const pack = makeFunctionReference<'action'>('projectJournalRun:pack');
  if (!input.laneId && !input.existing) {
    // A live drain reaches every non-Lane family by its ready index or cursor and reschedules only
    // for eligibility it finds, so one pending pack covers this wake and every later one.
    const now = Date.now();
    const row = await receiptRow(ctx, input.projectId, drainPointer);
    const pending = row
      ? (JSON.parse(row.envelope) as { at: number; jobId: Id<'_scheduled_functions'> })
      : null;
    let at = Math.ceil(Math.max(dueAt, now) / journalDrainBucketMs) * journalDrainBucketMs;
    // A started drain owns its bucket's operation id; a later drain never replays its pages.
    if (pending && pending.at <= now && at <= pending.at) at = pending.at + journalDrainBucketMs;
    if (pending && pending.at > now && pending.at <= at) return;
    // Only a still-pending drain is cancelled; a running one (this drain's own capture) keeps going.
    if (pending && pending.at > now) await cancelPendingTask(ctx, pending.jobId);
    const jobId = await ctx.scheduler.runAfter(at - now, pack, {
      projectId: input.projectId,
      operationId: `drain:${at}`,
    });
    const envelope = canonicalPayload({ at, jobId });
    const fields = {
      projectId: input.projectId,
      operationId: drainPointer,
      hash: digest(envelope),
      envelope,
    };
    if (row) await ctx.db.replace(row._id, fields);
    else await ctx.db.insert('projectJournalReceipts', fields);
    return;
  }
  // A closed Lane's save pages and operator runs name their own frontier.
  const operationId = journalEligibilityKey(input.operationId);
  if (operationId) {
    const old = await receiptRow(ctx, input.projectId, operationId);
    if (old) return;
    const envelope = canonicalPayload(input);
    await ctx.db.insert('projectJournalReceipts', {
      projectId: input.projectId,
      operationId,
      hash: digest(envelope),
      envelope,
    });
  }
  await ctx.scheduler.runAfter(Math.max(0, dueAt - Date.now()), pack, input);
}
/** Attached to the existing supersession write; no added RPC and no idle wake. */
/** Planning versions stay hot; superseded Intent versions can be rewritten by an Item purge. */
export const wordsKinds = new Set(['issue', 'comment']);
export async function readyJournalRecord(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  id: Id<'projectHostedRecords'>,
  kind: string,
) {
  if (process.env.FORGE_JOURNAL_SEGMENTS !== '1' || wordsKinds.has(kind)) return;
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
