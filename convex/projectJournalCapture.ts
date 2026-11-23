// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation } from './server';
import { canonicalPayload } from '../src/hosted-source-operation';
import { journalSegmentText, type JournalSegment } from '../src/journal-segment';
import { encodePlannedJournal } from './projectJournalArchivePlan';
import { invariant } from '../src/errors';
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
  pendingJournal,
  loadCaptured,
  logicalSegments,
  type Control,
  type JournalRunInput,
} from './projectJournalMaintenance';
export const page = internalMutation({
  args: {
    ...journalRunArgs,
    claim: v.string(),
    discarded: v.optional(v.array(v.string())),
    discardExpired: v.optional(v.literal(true)),
  },
  returns: v.string(),
  handler: async (ctx, { discarded, discardExpired, ...input }) => {
    if (!discardExpired && !journalEnabled()) return canonicalPayload({ kept: 'disabled' });
    const claimRow = await pendingJournal(ctx, input.projectId);
    const active = claimRow ? JSON.parse(claimRow.envelope) : null;
    if (
      active &&
      active.until > Date.now() &&
      (active.control !== phaseKey(input) || active.claim !== input.claim)
    )
      return canonicalPayload({ deferred: 'claimed', retryAt: active.until });
    const controlRow = await receiptRow(ctx, input.projectId, phaseKey(input));
    const control: Control = controlRow ? JSON.parse(controlRow.envelope) : {};
    // A legacy control can predate the project pointer. Its original claim still
    // owns this frontier until expiry; recapture publishes the same pointer.
    let pending = control.pending;
    if (pending && pending.claim !== input.claim && pending.until > Date.now())
      return canonicalPayload({ deferred: 'claimed', retryAt: pending.until });
    const wakeKey = journalEligibilityKey(input.operationId);
    if (wakeKey) {
      const wake = await receiptRow(ctx, input.projectId, wakeKey);
      if (wake) await ctx.db.delete(wake._id);
    }
    const pageId = pageKey(input);
    if (discardExpired && pending?.pageId !== pageId) return canonicalPayload({ kept: 'capture-changed' });
    if (input.existing && (input.phase ?? 0) < 3 && control.runId !== input.operationId && !control.pending) {
      delete control.cursor;
      control.runId = input.operationId;
    }
    if (control.last?.pageId === pageId) return control.last.result;
    const [published] = await ctx.db
      .query('projectJournalSegments')
      .withIndex('by_project_and_page', q => q.eq('projectId', input.projectId).eq('pageId', pageId))
      .take(1);
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
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal) return canonicalPayload({ kept: 'unavailable' });
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
        : await selectJournal(
            ctx,
            input,
            !input.existing && (input.phase ?? 0) < 2 ? [] : control.cursor,
            new Set(
              project.itemPurges?.flatMap(purge =>
                purge.purgedAt === undefined ? (purge.intentKeys ?? []) : [],
              ),
            ),
          );
      future = known ?? [];
      const { claim: invocationClaim, ...request } = input;
      void invocationClaim;
      if (!selected.refs.length) {
        // Empty frontiers contain no bytes to verify in R2 and need no capture
        // lease or publish round trip. Commit their cursor and continuation in
        // this transaction, including metadata cleanup and future eligibility.
        const next = selected.done
          ? { ...request, phase: (input.phase ?? 0) + 1, part: 0 }
          : { ...request, part: (input.part ?? 0) + 1 };
        const result = canonicalPayload({
          archived: 0,
          segments: 0,
          ...((!input.laneId || !selected.done) && (next.phase ?? 0) < 5 ? { next } : { done: true }),
        });
        if (input.laneId && selected.done) await putControl(ctx, input, null, controlRow, claimRow);
        else
          await putControl(
            ctx,
            input,
            {
              ...(control.runId ? { runId: control.runId } : {}),
              cursor: selected.cursor,
              last: { pageId, result },
            },
            controlRow,
            claimRow,
          );
        for (const wake of future) await wakeJournal(ctx, wake.input, wake.dueAt);
        return result;
      }
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
    const rows = discardExpired ? null : await loadCaptured(ctx, pending);
    if (!rows || discarded) {
      // An unpublished Intent page may already be in R2 after a lost PUT or a rejected publication.
      // Retain its physical pins until the action confirms deletion, then recapture the still-hot source.
      const staged = [
        ...new Set([...pending.pointers.map(pointer => pointer.sha256), ...(pending.planned ?? [])]),
      ];
      const indexed = await Promise.all(
        staged.map(key =>
          ctx.db
            .query('projectJournalSegments')
            .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', key))
            .unique(),
        ),
      );
      // A different capture can have published the same immutable bytes while this one lost its head proof.
      // A published root owns all its fragments, and only the Item sweep may replace that object.
      const retired =
        indexed[0] && indexed[0].category !== 'fragment'
          ? []
          : staged.filter((_, i) => !indexed[i] || indexed[i]!.category === 'fragment');
      if (retired.length && !discarded) {
        control.pending = pending;
        await putControl(ctx, input, control, controlRow, claimRow);
        return canonicalPayload({ discard: retired });
      }
      if (discarded) {
        invariant(
          !rows && canonicalPayload(discarded) === canonicalPayload(retired),
          'WORK_STALE',
          'Staged journal page changed.',
        );
        for (const row of indexed) if (row?.category === 'fragment') await ctx.db.delete(row._id);
      }
      delete control.pending;
      await putControl(ctx, input, control, controlRow, claimRow);
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
    const intentKeys = [
      ...new Set(
        rows.flatMap((row, i) =>
          pending.refs[i]?.table === 'projectHostedRecords' &&
          'kind' in row &&
          row.kind === 'intent' &&
          'key' in row
            ? [row.key]
            : [],
        ),
      ),
    ];
    if (intentKeys.length) {
      pending.intentKeys = intentKeys;
      pending.planned = texts.map(
        text => encodePlannedJournal(text, JSON.parse(text) as JournalSegment).pointer.sha256,
      );
    }
    control.pending = pending;
    await putControl(ctx, input, control, controlRow, claimRow);
    for (const wake of future) await wakeJournal(ctx, wake.input, wake.dueAt);
    return canonicalPayload({ pending, texts, fragmented });
  },
});
