// SPDX-License-Identifier: Apache-2.0
'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  journalTablePins,
  journalSegmentText,
  type JournalIndex,
  type JournalSegment,
} from '../src/journal-segment';
import { journalFragmentTexts } from '../src/journal-fragments';
import { decodeArchiveBytes, encodeArchiveBytes } from '../src/landing-capsule-bytes';
import {
  purgedFactsDigest,
  purgedFactsText,
  purgeableCommandSchema,
  redactPlanningWrite,
} from '../src/work-intent-types';
import { metadataRequest } from '../src/work-metadata';
import { PURGE_ROW_LIMIT } from '../src/work-planning-types';
import { digest } from '../src/state/hash';
import { getJournalSegment, journalObjectKey } from './projectJournalObject';
import { putArchiveObject } from './projectLandingCapsuleObject';
import { deleteR2Object } from './r2Operations';
import { r2Config } from './r2';
import { selectEventRows } from './projectPlanningPurgeSelect';
import { purgeSegmentIdentity } from './projectPlanningPurgeSegments';
import type { ItemPurge } from './projectPlanningPurgeRedact';
import type { ArchiveSelection } from './projectPlanningPurgeArchiveSelection';

type Entry = { key: string; index: JournalIndex };
type Page = { entries: Entry[]; after: string | null; done: boolean };

type Identity = { projectId: Id<'hostedProjects'>; operationId: string };
const store = internal.projectPlanningPurgeSegments;

/** Select archived commands while they are whole. An interrupted action resumes at its last verified page. */
export const select = internalAction({
  args: {
    ...purgeSegmentIdentity,
    itemId: v.string(),
    ids: v.array(v.string()),
    journalRevision: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, input): Promise<ArchiveSelection> => {
    const selection = internal.projectPlanningPurgeArchiveSelection;
    let progress = await ctx.runQuery(selection.resume, input);
    while (!progress.done) {
      const page: Page = await ctx.runQuery(store.page, {
        projectId: input.projectId,
        after: progress.cursor,
        events: true,
      });
      const selected: ArchiveSelection = { rows: [], decisions: [], created: null, creates: false };
      for (const entry of page.entries) {
        const segment = await getJournalSegment(input.projectId, entry.index);
        const matched = selectEventRows(
          (segment.tables.projectHostedRecordBodies ?? []).map(row => JSON.parse(row)),
          input.ids,
        );
        selected.rows.push(...matched.rows);
        selected.decisions.push(...matched.decisions);
        selected.creates ||= matched.creates;
        if (matched.created !== null)
          selected.created = Math.min(selected.created ?? matched.created, matched.created);
      }
      if (progress.selected.rows.length + selected.rows.length > PURGE_ROW_LIMIT) {
        await ctx.runMutation(selection.discard, {
          projectId: input.projectId,
          operationId: input.operationId,
        });
        invariant(
          false,
          'BAD_ARGUMENT',
          `This Item has more than ${PURGE_ROW_LIMIT} Work rows; a purge removes at most ${PURGE_ROW_LIMIT}.`,
        );
      }
      progress = await ctx.runMutation(selection.checkpoint, {
        ...input,
        expected: progress.cursor,
        next: page.after,
        done: page.done,
        selected,
      });
    }
    return progress.selected;
  },
});

/** Resume the durable index frontier, or retire the superseded objects of an already-published rewrite. */
export const run = internalAction({
  args: purgeSegmentIdentity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const id = { ...input, claim: crypto.randomUUID() };
    type State = {
      purge: ItemPurge;
      sweep: NonNullable<ItemPurge['segmentSweep']>;
      rows: [string, string][];
    };
    const state: State | null = await ctx.runMutation(store.claim, id);
    if (!state) return null;
    const retire = async (key: string, hashes: string[]) => {
      for (const hash of hashes) await deleteR2Object(r2Config(), journalObjectKey(input.projectId, hash));
      await ctx.runMutation(store.progress, { ...id, advance: { after: key, done: false } });
    };
    let completed = false;
    try {
      let after = state.sweep.after;
      if (state.sweep.pending?.retire) {
        await retire(state.sweep.pending.key, state.sweep.pending.retire);
        after = state.sweep.pending.key;
      }
      const rows = new Map(state.rows);
      for (;;) {
        const page: Page = await ctx.runQuery(store.page, { projectId: input.projectId, after });
        for (const entry of page.entries) {
          const hashes = await rewrite(ctx, id, entry, state.purge, rows);
          if (hashes) await retire(entry.key, hashes);
        }
        await ctx.runMutation(store.progress, { ...id, advance: { after: page.after, done: page.done } });
        if (page.done) {
          completed = true;
          return null;
        }
        after = page.after;
      }
    } finally {
      if (!completed) await ctx.runMutation(store.progress, { ...id, release: true });
    }
  },
});

async function rewrite(
  ctx: ActionCtx,
  id: Identity & { claim: string },
  entry: Entry,
  purge: ItemPurge,
  operations: ReadonlyMap<string, string>,
) {
  const segment = await getJournalSegment(id.projectId, entry.index);
  const { next, events } = redactSegment(segment, purge, operations);
  if (next === segment) return null;
  const expected = entry.index.pointer.sha256;
  const text = canonicalPayload(next);
  const physical =
    new TextEncoder().encode(text).length <= 500 * 1024
      ? [journalSegmentText(next)]
      : journalFragmentTexts(next);
  const encoded = physical.map(fragment =>
    encodeArchiveBytes(fragment, next.through, journalTablePins(JSON.parse(fragment).tables)),
  );
  const pointers = encoded.map(value => value.pointer);
  const stage = { ...id, key: entry.key, expected, planned: pointers.map(pin => pin.sha256) };
  const discarded = await ctx.runMutation(store.stage, stage);
  if (discarded.length) {
    for (const hash of discarded) await deleteR2Object(r2Config(), journalObjectKey(id.projectId, hash));
    const remaining = await ctx.runMutation(store.stage, { ...stage, discarded });
    invariant(!remaining.length, 'WORK_STALE', 'Staged replacement pins changed.');
  }
  for (const [i, value] of encoded.entries()) {
    const stored = await putArchiveObject(journalObjectKey(id.projectId, value.pointer.sha256), value);
    invariant(
      decodeArchiveBytes(stored, value.pointer) === physical[i],
      'EVIDENCE_CHANGED',
      'Rewritten journal bytes differ.',
    );
  }
  return ctx.runMutation(store.publish, {
    ...id,
    key: entry.key,
    expected,
    rewritten: digest(text),
    pointers,
    events,
  });
}

function redactSegment(segment: JournalSegment, purge: ItemPurge, operations: ReadonlyMap<string, string>) {
  const events: { id: Id<'projectHostedRecordBodies'>; facts: string }[] = [];
  const records = (segment.tables.projectHostedRecords ?? []).map(text => ({
    text,
    row: JSON.parse(text) as Doc<'projectHostedRecords'>,
  }));
  const targets = new Set(
    records
      .filter(
        ({ row }) =>
          !row.purged &&
          ((row.kind === 'intent' && purge.intentKeys?.includes(row.key)) ||
            (row.kind === 'issue' && purge.ids.includes(row.key)) ||
            ((row.kind === 'comment' || row.kind === 'lifecycle') &&
              (purge.ids.includes(row.parent) || purge.intentKeys?.includes(row.parent)))),
      )
      .map(({ row }) => row._id),
  );
  const retainedBodies = new Set(
    records.filter(({ row }) => !targets.has(row._id) && !row.purged).map(({ row }) => row.bodyId),
  );
  const redactedBodies = new Set(
    records.filter(({ row }) => targets.has(row._id)).map(({ row }) => row.bodyId),
  );
  let changed = targets.size > 0;
  const next = { ...segment, tables: { ...segment.tables } };
  if (targets.size)
    next.tables.projectHostedRecords = records.map(({ text, row }) => {
      if (!targets.has(row._id)) return text;
      const header = { ...row, purged: purge.operationId };
      delete header.inline;
      return canonicalPayload(header);
    });
  if (segment.tables.projectHostedRecordBodies)
    next.tables.projectHostedRecordBodies = segment.tables.projectHostedRecordBodies.map(text => {
      const row = JSON.parse(text) as Doc<'projectHostedRecordBodies'>;
      if (
        row.operationId !== undefined &&
        operations.has(row.operationId) &&
        row.purged === undefined &&
        row.command
      ) {
        const command = purgeableCommandSchema.parse(JSON.parse(row.command));
        const facts = redactPlanningWrite(command);
        invariant(
          metadataRequest(command) === row.request &&
            purgedFactsDigest(facts) === operations.get(row.operationId),
          'INVALID_WORK_JOURNAL',
          'An archived row changed after the purge.',
        );
        const journalCommand = purgedFactsText(facts);
        const header = { ...row, journalCommand, purged: purge.operationId, value: '' };
        delete header.command;
        events.push({ id: row._id, facts: journalCommand });
        changed = true;
        return canonicalPayload(header);
      }
      if (
        row.operationId === undefined &&
        row.value &&
        redactedBodies.has(row._id) &&
        !retainedBodies.has(row._id)
      ) {
        changed = true;
        return canonicalPayload({ ...row, value: '' });
      }
      return text;
    });
  return { next: changed ? next : segment, events };
}
