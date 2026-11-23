// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import type { JournalIndex } from '../src/journal-segment';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from './server';
import { planningArchiveBackfillProgress } from './projectJournalFields';
import {
  hasProjectArchiveCoverage,
  readArchiveCoverage,
  saveArchiveCoverage,
} from './projectPlanningArchiveCoverage';
import {
  archiveIndexKind,
  archiveIndexPageSize,
  archivedSegmentRows,
  indexArchiveTargets,
} from './projectPlanningArchiveIndex';

type Progress = typeof planningArchiveBackfillProgress.type;
const projectId = v.id('hostedProjects');
const position = v.union(planningArchiveBackfillProgress, v.null());
const entry = v.object({ key: v.string(), index: v.string() });
const pageResult = v.union(
  v.null(),
  v.object({
    from: position,
    next: position,
    entries: v.array(entry),
    finish: v.boolean(),
  }),
);

const archiveRows = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, legacyRecords: boolean) =>
  ctx.db.query('projectJournalSegments').withIndex('by_project_and_scope_and_from', q => {
    const scope = q.eq('projectId', projectId);
    return legacyRecords ? scope.gte('scope', 'record:').lt('scope', 'record;') : scope.eq('scope', 'events');
  });

function boundedEntries(rows: Doc<'projectJournalSegments'>[]) {
  const entries: { key: string; index: string }[] = [];
  let gets = 0;
  let bytes = 0;
  for (const row of rows) {
    const index = JSON.parse(row.value) as JournalIndex;
    const pins = [index.pointer, ...(index.parts ?? [])];
    const size = pins.reduce((total, pin) => total + pin.rawSize, 0);
    // A single unusually large segment still makes progress, on a page of its own.
    if (entries.length && (gets + pins.length > archiveIndexPageSize || bytes + size > 8 * 1024 * 1024))
      break;
    gets += pins.length;
    bytes += size;
    entries.push({ key: row.key, index: row.value });
  }
  return entries;
}

export const page = internalQuery({
  args: { projectId },
  returns: pageResult,
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal) return null;
    const { state } = await readArchiveCoverage(ctx, project);
    if (state.ready)
      return hasProjectArchiveCoverage(project)
        ? { from: null, next: null, entries: [], finish: true }
        : null;
    const from = state.progress ?? null;
    const current: Progress = from ?? {
      mode: 'index',
      legacyRecords: false,
      cursor: null,
      pending: [],
      rangeDone: false,
      indexed: 0,
      expected: 0,
    };
    const counting = current.mode === 'count';
    let rows: Doc<'projectJournalSegments'>[];
    let next = { ...current };
    if (current.pending.length) rows = await archivedSegmentRows(ctx, input.projectId, current.pending);
    else {
      // A native cursor starts at the actual index range. An empty exclusive stream key
      // can replace the range's lower bound and omit the project's first archive page.
      const pageSize = counting ? 256 : archiveIndexPageSize;
      const page = await archiveRows(ctx, input.projectId, current.legacyRecords).paginate({
        cursor: current.cursor,
        numItems: pageSize,
        maximumRowsRead: pageSize,
        maximumBytesRead: 256 * 1024,
      });
      rows = page.page.filter(row => row.category === (current.legacyRecords ? 'record' : 'events'));
      next.cursor = page.isDone ? null : page.continueCursor;
      next.rangeDone = page.isDone;
    }
    const entries = counting ? [] : boundedEntries(rows);
    if (counting) next.expected += rows.length;
    else {
      next.indexed += entries.length;
      next.pending = rows.slice(entries.length).map(row => row.key);
    }
    const end = next.rangeDone && !next.pending.length;
    const finish = end && current.legacyRecords && counting;
    if (end && !finish)
      next = {
        ...next,
        cursor: null,
        rangeDone: false,
        legacyRecords: !current.legacyRecords,
        mode: current.legacyRecords ? 'count' : current.mode,
      };
    return { from, next, entries, finish };
  },
});

/** Commit only verified objects. A second metadata-only pass must agree before enabling indexed purge. */
export const commit = internalMutation({
  args: {
    projectId,
    from: position,
    next: position,
    finish: v.boolean(),
    entries: v.array(
      v.object({
        key: v.string(),
        targets: v.array(v.object({ kind: archiveIndexKind, itemId: v.string() })),
      }),
    ),
  },
  returns: v.object({ advanced: v.boolean(), done: v.boolean() }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal) return { advanced: false, done: false };
    const { row, state } = await readArchiveCoverage(ctx, project);
    if (!input.next) {
      if (!state.ready || !hasProjectArchiveCoverage(project))
        return { advanced: false, done: !!state.ready };
      await saveArchiveCoverage(ctx, project, row, state);
      return { advanced: true, done: true };
    }
    if (state.ready || canonicalPayload(state.progress ?? null) !== canonicalPayload(input.from))
      return { advanced: false, done: !!state.ready };
    invariant(
      input.next.indexed === (input.from?.indexed ?? 0) + input.entries.length,
      'EVIDENCE_CHANGED',
      'Item archive coverage differs from the verified page.',
    );
    for (const { key, targets } of input.entries)
      await indexArchiveTargets(ctx, input.projectId, key, targets);
    if (input.finish && input.next.expected !== input.next.indexed) {
      // A pre-existing fragment can publish during the count. Start a fresh count.
      await saveArchiveCoverage(ctx, project, row, { eventRevision: state.eventRevision });
      return { advanced: false, done: false };
    }
    await saveArchiveCoverage(ctx, project, row, {
      eventRevision: state.eventRevision,
      ...(input.finish ? { ready: true } : { progress: input.next }),
    });
    return { advanced: true, done: input.finish };
  },
});

export type ArchiveBackfillPage = typeof pageResult.type;
