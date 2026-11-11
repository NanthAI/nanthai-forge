// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { canonicalPayload } from '../src/hosted-source-operation';
import { journalSegmentText } from '../src/journal-segment';
import { journalFragmentTexts } from '../src/journal-fragments';
import { wakeJournal, journalEligibilityKey } from './projectJournalWake';
import { selectJournal } from './projectJournalSelect';
import {
  journalRunArgs,
  journalEnabled,
  phaseKey,
  pageKey,
  receiptRow,
  putControl,
  loadCaptured,
  logicalSegments,
  type Control,
  type JournalRunInput,
} from './projectJournalMaintenance';
export const page = internalMutation({
  args: { ...journalRunArgs, claim: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    if (!journalEnabled()) return canonicalPayload({ kept: 'disabled' });
    const wakeKey = journalEligibilityKey(input.operationId);
    if (wakeKey) {
      const wake = await receiptRow(ctx, input.projectId, wakeKey);
      if (wake) await ctx.db.delete(wake._id);
    }
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal) return canonicalPayload({ kept: 'unavailable' });
    const controlRow = await receiptRow(ctx, input.projectId, phaseKey(input));
    const control: Control = controlRow ? JSON.parse(controlRow.envelope) : {};
    const pageId = pageKey(input);
    if (input.existing && (input.phase ?? 0) < 3 && control.runId !== input.operationId && !control.pending) {
      delete control.cursor;
      control.runId = input.operationId;
    }
    if (control.last?.pageId === pageId) return control.last.result;
    const published = await ctx.db
      .query('projectJournalSegments')
      .withIndex('by_project_and_page', q => q.eq('projectId', input.projectId).eq('pageId', pageId))
      .first();
    if (published) {
      const saved = JSON.parse(published.value).pageReceipt;
      if (typeof saved === 'string') return saved;
      const { claim: ignoredClaim, ...request } = input;
      void ignoredClaim;
      return canonicalPayload({
        archived: saved[0],
        segments: saved[1],
        ...(saved.length > 2 ? { next: { ...request, phase: saved[2], part: saved[3] } } : { done: true }),
      });
    }
    let pending = control.pending;
    if (pending && pending.claim !== input.claim && pending.until > Date.now())
      return canonicalPayload({ deferred: 'claimed' });
    let future: { input: JournalRunInput; dueAt: number }[] = [];
    if (!pending) {
      // Expired scheduling dedup facts are derived metadata, not logical history.
      // A metadata-only page also clears markers left by a temporarily disabled job.
      const expired = await ctx.db
        .query('projectJournalReceipts')
        .withIndex('by_project_and_operation', q =>
          q
            .eq('projectId', input.projectId)
            .gte('operationId', 'journal-wake:')
            .lt('operationId', `journal-wake:${String(Math.floor(Date.now())).padStart(16, '0')}~`),
        )
        .take(100);
      for (const marker of expired) await ctx.db.delete(marker._id);
      const { future: known, ...selected } = expired.length
        ? { refs: [], proofs: [], groups: [], cursor: control.cursor ?? [], done: false, future: [] }
        : await selectJournal(ctx, input, !input.existing && (input.phase ?? 0) < 2 ? [] : control.cursor);
      future = known ?? [];
      const { claim: invocationClaim, ...request } = input;
      void invocationClaim;
      pending = {
        ...selected,
        pageId,
        input: request,
        claim: input.claim,
        until: Date.now() + 10 * 60_000,
        fragment: 0,
        pointers: [],
      };
    }
    pending.claim = input.claim;
    pending.until = Date.now() + 10 * 60_000;
    const rows = await loadCaptured(ctx, pending);
    if (!rows) {
      // No source has been removed; retry selection at the same durable frontier.
      delete control.pending;
      await putControl(ctx, input, control);
      const { claim: ignoredClaim, ...request } = input;
      void ignoredClaim;
      return canonicalPayload({ stale: true, next: request });
    }
    const segments = await logicalSegments(pending, rows);
    const texts: string[] = [];
    let fragmented = false;
    for (const segment of segments) {
      const bytes = Object.values(segment.tables)
        .flat()
        .reduce((n, text) => n + new TextEncoder().encode(text!).length, 0);
      if (
        bytes > 500 * 1024 ||
        new TextEncoder().encode(canonicalPayload({ texts: [canonicalPayload(segment)] })).length > 400 * 1024
      ) {
        const parts = journalFragmentTexts(segment);
        texts.push(parts[pending.fragment]!);
        fragmented = pending.fragment + 1 < parts.length;
      } else texts.push(journalSegmentText(segment));
    }
    control.pending = pending;
    await putControl(ctx, input, control);
    for (const wake of future) await wakeJournal(ctx, wake.input, wake.dueAt);
    return canonicalPayload({ pending, texts, fragmented });
  },
});
