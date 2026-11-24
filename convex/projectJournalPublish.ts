// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation } from './server';
import { logIoAttribution } from './ioAttribution';
import { landingCapsulePointer } from './projectLandingCapsuleFields';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { journalTablePins, type JournalIndex, type JournalSegment } from '../src/journal-segment';
import { journalFragmentTexts } from '../src/journal-fragments';
import { invariant } from '../src/errors';
import {
  journalRunArgs,
  journalIoMode,
  phaseKey,
  pageKey,
  receiptRow,
  putControl,
  pendingJournal,
  loadCaptured,
  logicalSegments,
  type Control,
} from './projectJournalMaintenance';
import { applyJournal } from './projectJournalEffects';
import { readArchiveCoverage, saveArchiveCoverage } from './projectPlanningArchiveCoverage';
export const page = internalMutation({
  args: {
    ...journalRunArgs,
    claim: v.string(),
    pointers: v.array(landingCapsulePointer),
    hashes: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const mode = journalIoMode(input);
    const reply = async (outcome: string, result: string) => {
      await logIoAttribution(ctx, `journal-publish/${mode}/${outcome}`);
      return result;
    };
    const first = input.pointers[0];
    if (first) {
      const old = await ctx.db
        .query('projectJournalSegments')
        .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', first.sha256))
        .unique();
      const saved = old ? JSON.parse(old.value) : null;
      const {
        claim: invocationClaim,
        pointers: originalPointers,
        hashes: originalHashes,
        ...request
      } = input;
      void originalPointers;
      void originalHashes;
      if (saved?.fragmentClaim === invocationClaim)
        return reply('replay', canonicalPayload({ archived: 0, segments: 1, next: request }));
      if (old?.pageId === pageKey(input) && Array.isArray(saved.pageReceipt)) {
        const receipt = saved.pageReceipt;
        return reply(
          'replay',
          canonicalPayload({
            archived: receipt[0],
            segments: receipt[1],
            ...(receipt.length > 2
              ? { next: { ...request, phase: receipt[2], part: receipt[3] } }
              : { done: true }),
          }),
        );
      }
    }
    const row = await receiptRow(ctx, input.projectId, phaseKey(input));
    const control: Control = row ? JSON.parse(row.envelope) : {};
    if (control.last?.pageId === pageKey(input)) return reply('replay', control.last.result);
    const claimRow = await pendingJournal(ctx, input.projectId);
    const active = claimRow ? JSON.parse(claimRow.envelope) : null;
    if (active && (active.control !== phaseKey(input) || active.claim !== input.claim))
      return reply('claimed', canonicalPayload({ deferred: 'claimed', retryAt: active.until }));
    const pending = control.pending;
    invariant(pending && pending.claim === input.claim, 'WORK_STALE', 'Archive capture claim changed.');
    invariant(
      !pending.planned ||
        canonicalPayload(pending.planned) === canonicalPayload(input.pointers.map(pin => pin.sha256)),
      'EVIDENCE_CHANGED',
      'Uploaded journal bytes differ from the capture pins.',
    );
    const rows = await loadCaptured(ctx, pending);
    if (!rows && pending.planned) return reply('stale', canonicalPayload({ staleCapture: true }));
    invariant(rows, 'WORK_STALE', 'Captured source changed before archive publication.');
    const segments = await logicalSegments(pending, rows);
    let fragmented = false,
      incomplete = false;
    const selected = segments.map(segment => {
      const bytes = Object.values(segment.tables)
        .flat()
        .reduce((n, text) => n + new TextEncoder().encode(text!).length, 0);
      if (
        bytes <= 500 * 1024 &&
        new TextEncoder().encode(canonicalPayload({ texts: [canonicalPayload(segment)] })).length <=
          400 * 1024
      )
        return canonicalPayload(segment);
      fragmented = true;
      const parts = journalFragmentTexts(segment);
      incomplete = pending.fragment + 1 < parts.length;
      return parts[pending.fragment]!;
    });
    invariant(
      selected.length === input.pointers.length &&
        selected.every(
          (text, i) =>
            digest(text) === input.hashes[i] &&
            input.pointers[i]!.rawSize === new TextEncoder().encode(text).length &&
            input.pointers[i]!.tables ===
              canonicalPayload(journalTablePins((JSON.parse(text) as JournalSegment).tables)),
        ),
      'EVIDENCE_CHANGED',
      'Verified archive page differs from capture.',
    );
    let next = { ...pending.input, part: (pending.input.part ?? 0) + 1 };
    if (pending.done) next = { ...next, phase: (pending.input.phase ?? 0) + 1, part: 0 };
    const result = canonicalPayload({
      archived: incomplete ? 0 : pending.refs.length,
      segments: input.pointers.length,
      ...(incomplete
        ? { next: pending.input }
        : (!pending.input.laneId || !pending.done) && (next.phase ?? 0) < 5
          ? { next }
          : { done: true }),
    });
    for (const [i, pointer] of input.pointers.entries()) {
      const group = pending.groups[i]!;
      const index: JournalIndex & { pageReceipt?: number[]; fragmentClaim?: string } = {
        scope: group.scope,
        from: group.from,
        through: group.through,
        pointer,
        ...(group.keys ? { keys: group.keys, startKey: group.startKey, endKey: group.endKey } : {}),
        ...(group.category === 'save'
          ? {
              savePages: group.refs.map(n => {
                const page = rows[n] as { index: number; digest: string };
                return [page.index, page.digest];
              }),
            }
          : {}),
      };
      if (incomplete) index.fragmentClaim = input.claim;
      const old = await ctx.db
        .query('projectJournalSegments')
        .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', pointer.sha256))
        .unique();
      const fields = {
        projectId: input.projectId,
        key: pointer.sha256,
        scope: fragmented ? `fragment:${pending.pageId}` : group.scope,
        from: group.from,
        through: group.through,
        category: fragmented ? ('fragment' as const) : group.category,
        ...(group.startKey ? { firstPosition: group.startKey, lastPosition: group.endKey } : {}),
        ...(group.laneId ? { laneId: group.laneId } : {}),
        ...(group.intentId ? { intentId: group.intentId } : {}),
        ...(group.recipientActor ? { recipientActor: group.recipientActor } : {}),
        value: canonicalPayload(index),
      };
      if (!old) await ctx.db.insert('projectJournalSegments', fields);
      if (!fragmented || !incomplete) {
        const root = fragmented ? pending.pointers[0]! : pointer;
        const rootRow = await ctx.db
          .query('projectJournalSegments')
          .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', root.sha256))
          .unique();
        invariant(rootRow, 'SOURCE_UNAVAILABLE', 'Verified archive index is unavailable.');
        index.pointer = root;
        if (fragmented) index.parts = [...pending.pointers.slice(1), pointer];
        if (i === 0)
          index.pageReceipt = [
            pending.refs.length,
            input.pointers.length,
            ...(JSON.parse(result).next ? [next.phase ?? 0, next.part ?? 0] : []),
          ];
        await ctx.db.patch(rootRow._id, {
          scope: group.scope,
          category: group.category,
          ...(i === 0 ? { pageId: pending.pageId } : {}),
          value: canonicalPayload(index),
        });
      }
    }
    if (incomplete) {
      pending.pointers.push(...input.pointers);
      delete pending.planned;
      pending.fragment++;
      pending.until = 0;
      await putControl(ctx, pending.input, { ...control, pending }, row, claimRow);
    } else {
      const indexedEvents = await applyJournal(
        ctx,
        pending,
        rows,
        fragmented ? [pending.pointers[0]!.sha256] : input.pointers.map(pointer => pointer.sha256),
      );
      const project = await ctx.db.get(input.projectId);
      invariant(project && !project.removal, 'WORK_STALE', 'Archive project changed.');
      if (indexedEvents) {
        const { row, state } = await readArchiveCoverage(ctx, project);
        await saveArchiveCoverage(ctx, project, row, { ...state, eventRevision: state.eventRevision + 1 });
      }
      if (rows.length)
        await ctx.db.patch(project._id, {
          journalRevision: (project.journalRevision ?? 0) + 1,
          journalRecordReceipts: true,
        });
      if (pending.input.laneId && pending.done) await putControl(ctx, pending.input, null, row, claimRow);
      else
        await putControl(
          ctx,
          pending.input,
          {
            ...(control.runId ? { runId: control.runId } : {}),
            cursor: pending.cursor,
            last: { pageId: pending.pageId, result },
          },
          row,
          claimRow,
        );
    }
    return reply(fragmented ? 'fragment' : rows.length ? 'selected' : 'empty', result);
  },
});
