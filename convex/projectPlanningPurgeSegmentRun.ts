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
import { networkTimeout } from './networkFetch';
import { selectEventRows } from './projectPlanningPurgeSelect';
import { purgeSegmentIdentity } from './projectPlanningPurgeSegments';
import type { ItemPurge } from './projectPlanningPurgeRedact';
import type { ArchivePin, ArchiveSelection, SelectionProgress } from './projectPlanningPurgeArchiveSelection';

type Entry = { key: string; index: JournalIndex };
type Page = { entries: Entry[]; after: string | null; done: boolean };

type Identity = { projectId: Id<'hostedProjects'>; operationId: string };
const archiveBatch = 8;
const metrics = () => ({ segments: 0, gets: 0, storedBytes: 0, rawBytes: 0 });
type Metrics = ReturnType<typeof metrics>;

async function* verifiedEntries<T extends { index: JournalIndex }>(
  id: Identity,
  entries: T[],
  tally: Metrics,
  deadline: number,
  signal: AbortSignal,
) {
  for (let i = 0; i < entries.length && Date.now() < deadline; i += archiveBatch) {
    // Wait for every started read, then expose only the ordered verified prefix.
    const results = await Promise.allSettled(
      entries.slice(i, i + archiveBatch).map(async entry => {
        const segment = await getJournalSegment(id.projectId, entry.index, signal);
        tally.segments++;
        for (const pin of [entry.index.pointer, ...(entry.index.parts ?? [])]) {
          tally.gets++;
          tally.storedBytes += pin.size;
          tally.rawBytes += pin.rawSize;
        }
        return { entry, segment };
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        if (signal.aborted || Date.now() >= deadline) return;
        throw result.reason;
      }
      yield result.value;
    }
  }
}

function reportSlice(
  id: Identity,
  phase: 'selection' | 'sweep',
  tally: Metrics,
  started: number,
  done: boolean,
  indexed: boolean,
) {
  if (tally.segments || indexed)
    console.log(
      `FORGE_ITEM_PURGE_ARCHIVE ${JSON.stringify({
        projectId: id.projectId,
        operationId: id.operationId,
        phase,
        indexed,
        ...tally,
        wallMs: Math.round(performance.now() - started),
        sampledRss: process.memoryUsage().rss,
        done,
      })}`,
    );
}
const store = internal.projectPlanningPurgeSegments;

/** Select archived commands while they are whole. An interrupted action resumes at its last verified page. */
export const select = internalAction({
  args: {
    ...purgeSegmentIdentity,
    itemId: v.string(),
    ids: v.array(v.string()),
    deadline: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, input): Promise<{ done: boolean; selected: ArchiveSelection; pin: ArchivePin }> => {
    const selection = internal.projectPlanningPurgeArchiveSelection;
    const { deadline, ...request } = input;
    const started = performance.now();
    const tally = metrics();
    const signal = networkTimeout(Math.max(1, deadline - Date.now()));
    let progress: SelectionProgress = await ctx.runQuery(selection.resume, request);
    const pin = (): ArchivePin => ({
      frontier: progress.frontier,
      rewriteRevision: progress.rewriteRevision,
      ...(progress.indexedRevision === undefined ? {} : { indexedRevision: progress.indexedRevision }),
    });
    try {
      while (!progress.done && Date.now() < deadline) {
        const page = await ctx.runQuery(selection.page, {
          projectId: input.projectId,
          after: progress.frontier,
          ...(progress.indexedAfter ? { indexed: { ids: input.ids, cursor: progress.indexedAfter } } : {}),
        });
        const selected: ArchiveSelection = { rows: [], decisions: [], created: null, creates: false };
        let scanned = 0;
        for await (const { segment } of verifiedEntries(input, page.entries, tally, deadline, signal)) {
          const matched = selectEventRows(
            (segment.tables.projectHostedRecordBodies ?? []).map(row => JSON.parse(row)),
            page.indexed?.itemId ? [page.indexed.itemId] : input.ids,
          );
          selected.rows.push(...matched.rows);
          selected.decisions.push(...matched.decisions);
          selected.creates ||= matched.creates;
          if (matched.created !== null)
            selected.created = Math.min(selected.created ?? matched.created, matched.created);
          scanned++;
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
        if (scanned || !page.entries.length)
          progress = await ctx.runMutation(selection.checkpoint, {
            ...request,
            expected: pin(),
            next: page.indexed ? null : (page.entries[scanned - 1]?.pin ?? progress.frontier),
            ...(page.indexed && progress.indexedAfter
              ? {
                  indexed: {
                    expected: progress.indexedAfter,
                    next:
                      scanned === page.entries.length
                        ? page.indexed.next
                        : { target: page.indexed.target, after: page.entries[scanned - 1]!.pin.key },
                  },
                }
              : {}),
            done: page.done && scanned === page.entries.length,
            selected,
          });
        if (scanned < page.entries.length) break;
      }
    } finally {
      reportSlice(input, 'selection', tally, started, progress.done, progress.indexedRevision !== undefined);
    }
    return {
      done: progress.done,
      selected: progress.selected,
      pin: pin(),
    };
  },
});

/** Resume the durable index frontier, or retire the superseded objects of an already-published rewrite. */
export const run = internalAction({
  args: { ...purgeSegmentIdentity, deadline: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { deadline, ...input }) => {
    if (Date.now() >= deadline) return false;
    const id = { ...input, claim: crypto.randomUUID() };
    type State = {
      purge: ItemPurge;
      sweep: NonNullable<ItemPurge['segmentSweep']>;
      rows: [string, string][];
    };
    const state: State | null = await ctx.runMutation(store.claim, id);
    if (!state) return true;
    const started = performance.now();
    const tally = metrics();
    const signal = networkTimeout(Math.max(1, deadline - Date.now()));
    let after = state.sweep.after;
    const retire = async (key: string, hashes: string[]) => {
      for (const hash of hashes)
        await deleteR2Object(r2Config(), journalObjectKey(input.projectId, hash), signal);
      if (!state.sweep.indexed) after = key;
      await ctx.runMutation(store.progress, { ...id, advance: { after, done: false } });
    };
    let completed = false;
    try {
      if (state.sweep.pending?.retire) {
        await retire(state.sweep.pending.key, state.sweep.pending.retire);
      }
      const rows = new Map(state.rows);
      const scannedKeys = new Set<string>();
      const indexed = state.sweep.indexed
        ? { ids: state.purge.ids, intentKeys: state.purge.intentKeys! }
        : undefined;
      while (Date.now() < deadline) {
        const page: Page = await ctx.runQuery(store.page, {
          projectId: input.projectId,
          after,
          ...(indexed ? { indexed } : {}),
        });
        const entries = indexed ? page.entries.filter(entry => !scannedKeys.has(entry.key)) : page.entries;
        let scanned = 0;
        for await (const { entry, segment } of verifiedEntries(input, entries, tally, deadline, signal)) {
          const redacted = redactSegment(segment, state.purge, rows);
          if (redacted.next !== segment) {
            if (signal.aborted || Date.now() >= deadline) break;
            const hashes = await rewrite(ctx, id, entry, redacted, signal);
            await retire(entry.key, hashes);
          }
          if (indexed) scannedKeys.add(entry.key);
          scanned++;
        }
        if (scanned < entries.length) {
          if (scanned && !indexed)
            await ctx.runMutation(store.progress, {
              ...id,
              advance: { after: page.entries[scanned - 1]!.key, done: false },
            });
          return false;
        }
        await ctx.runMutation(store.progress, { ...id, advance: { after: page.after, done: page.done } });
        if (page.done) {
          completed = true;
          return true;
        }
        after = page.after;
      }
      return false;
    } catch (error) {
      if (!signal.aborted) throw error;
      return false;
    } finally {
      reportSlice(input, 'sweep', tally, started, completed, !!state.sweep.indexed);
      if (!completed) await ctx.runMutation(store.progress, { ...id, release: true });
    }
  },
});

async function rewrite(
  ctx: ActionCtx,
  id: Identity & { claim: string },
  entry: Entry,
  { next, events }: ReturnType<typeof redactSegment>,
  signal: AbortSignal,
) {
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
    for (const hash of discarded)
      await deleteR2Object(r2Config(), journalObjectKey(id.projectId, hash), signal);
    const remaining = await ctx.runMutation(store.stage, { ...stage, discarded });
    invariant(!remaining.length, 'WORK_STALE', 'Staged replacement pins changed.');
  }
  for (const [i, value] of encoded.entries()) {
    const stored = await putArchiveObject(
      journalObjectKey(id.projectId, value.pointer.sha256),
      value,
      signal,
    );
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
