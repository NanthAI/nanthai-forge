// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { finishRow } from './projectHostedFinishWake';
import { landingRow } from './projectHostedLandingStore';
import { landingMessageText } from './projectHostedLandingMessageBody';
import { channelRow } from './projectHostedChannels';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { discardedRunnerSeconds } from '../src/cost-budgets';
import { FYI_LANDINGS, fyiLandingFact } from './projectRecentLandingTitles';

type LegacyReceipt = Omit<Parameters<typeof fyiLandingFact>[0], 'submissionId'> & {
  id: string;
  message?: string;
  messageRef?: string;
};
type SelectedFact = ReturnType<typeof fyiLandingFact> & { receiptId: string; sequence: number };

export async function fyiLandingWindow(ctx: QueryCtx, projectId: Id<'hostedProjects'>, since: number) {
  const [channel, snapshots] = await Promise.all([
    channelRow(ctx, projectId),
    ctx.db
      .query('projectHostedAcceptanceSnapshots')
      .withIndex('by_project_and_revision', q => q.eq('projectId', projectId).gt('sourceRevision', since))
      .order('desc')
      .take(FYI_LANDINGS + 1),
  ]);
  const facts: SelectedFact[] = [];
  // A legacy publisher or an archived snapshot can leave a gap. The remaining
  // window comes from the canonical receipts, so the lookahead never skips one.
  const frontier = channel ? JSON.parse(channel.selection).sourceRevision : null;
  for (const row of snapshots) {
    if (frontier === null || row.sourceRevision !== frontier - facts.length || !row.fyi) break;
    facts.push({
      ...row.fyi,
      receiptId: row.receiptId,
      sequence: row.sourceRevision,
    });
  }
  const oldest = facts.at(-1)?.sequence;
  const missing = FYI_LANDINGS + 1 - facts.length;
  const legacy =
    missing > 0 && (oldest === undefined || oldest > since + 1)
      ? await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_sequence', q => {
            const start = q.eq('projectId', projectId).gt('sequence', since);
            return oldest === undefined ? start : start.lt('sequence', oldest);
          })
          .order('desc')
          .take(missing)
      : [];
  const compact = facts.filter(fact => !fact.hidden);
  const older = legacy
    .map(row => ({ row, receipt: JSON.parse(row.value) as LegacyReceipt }))
    .filter(({ receipt }) => receipt.checked !== false);
  const totalChecked = compact.length + older.length;
  for (const { row, receipt } of older.slice(0, Math.max(0, FYI_LANDINGS - compact.length))) {
    const finish = await finishRow(ctx, { projectId, submissionId: row.submissionId });
    const intentId = finish
      ? ((JSON.parse(finish.value) as { source?: { intentId?: string } }).source?.intentId ?? null)
      : null;
    compact.push({
      ...fyiLandingFact(
        { ...receipt, submissionId: row.submissionId },
        await landingMessageText(ctx, projectId, receipt),
        intentId,
      ),
      receiptId: receipt.id,
      sequence: row.sequence,
    });
  }
  const laneIds = new Map<string, string | null>();
  const rows = [];
  for (const { intentId, recheckSubmissionId, ...fact } of compact.slice(0, FYI_LANDINGS)) {
    if (intentId && !laneIds.has(intentId)) {
      const lane = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
        )
        .first();
      laneIds.set(intentId, lane?.key ?? null);
    }
    // A cancelled check can report its actual runner time after acceptance.
    const landing = recheckSubmissionId
      ? await landingRow(ctx, { projectId, submissionId: recheckSubmissionId })
      : null;
    const parsed = landing ? storedLandingStateSchema.safeParse(JSON.parse(landing.value)) : null;
    rows.push({
      ...fact,
      agent: fact.agent === true,
      checked: fact.checked === true,
      redone: recheckSubmissionId !== undefined,
      redoneWhy: fact.redoneWhy ?? null,
      laneId: intentId ? (laneIds.get(intentId) ?? null) : null,
      thrown: recheckSubmissionId ? discardedRunnerSeconds(parsed?.success ? parsed.data : null) : 0,
    });
  }
  return { landings: rows, landingsMore: totalChecked > FYI_LANDINGS };
}
