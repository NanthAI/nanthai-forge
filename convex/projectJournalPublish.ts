// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { landingCapsulePointer } from './projectLandingCapsuleFields';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { journalTablePins, type JournalIndex, type JournalSegment } from '../src/journal-segment';
import { journalFragmentTexts } from '../src/journal-fragments';
import { invariant } from '../src/errors';
import {
  journalRunArgs,
  phaseKey,
  pageKey,
  receiptRow,
  putControl,
  loadCaptured,
  logicalSegments,
  type Control,
} from './projectJournalMaintenance';
import { applyJournal } from './projectJournalEffects';
export const page = internalMutation({
  args: {
    ...journalRunArgs,
    claim: v.string(),
    pointers: v.array(landingCapsulePointer),
    hashes: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
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
        return canonicalPayload({ archived: 0, segments: 1, next: request });
      if (old?.pageId === pageKey(input) && Array.isArray(saved.pageReceipt)) {
        const receipt = saved.pageReceipt;
        return canonicalPayload({
          archived: receipt[0],
          segments: receipt[1],
          ...(receipt.length > 2
            ? { next: { ...request, phase: receipt[2], part: receipt[3] } }
            : { done: true }),
        });
      }
    }
    const row = await receiptRow(ctx, input.projectId, phaseKey(input));
    const control: Control = row ? JSON.parse(row.envelope) : {};
    if (control.last?.pageId === pageKey(input)) return control.last.result;
    const pending = control.pending;
    invariant(pending && pending.claim === input.claim, 'WORK_STALE', 'Archive capture claim changed.');
    const rows = await loadCaptured(ctx, pending);
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
      pending.fragment++;
      pending.until = 0;
      await putControl(ctx, pending.input, { ...control, pending });
    } else {
      await applyJournal(
        ctx,
        pending,
        rows,
        fragmented ? [pending.pointers[0]!.sha256] : input.pointers.map(pointer => pointer.sha256),
      );
      const project = await ctx.db.get(input.projectId);
      invariant(project && !project.removal, 'WORK_STALE', 'Archive project changed.');
      if (rows.length)
        await ctx.db.patch(project._id, {
          journalRevision: (project.journalRevision ?? 0) + 1,
          journalRecordReceipts: true,
        });
      if (pending.input.laneId && pending.done) await ctx.db.delete(row!._id);
      else
        await putControl(ctx, pending.input, {
          ...(control.runId ? { runId: control.runId } : {}),
          cursor: pending.cursor,
          last: { pageId: pending.pageId, result },
        });
    }
    return result;
  },
});
