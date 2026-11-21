// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { stream, type IndexKey } from 'convex-helpers/server/stream';
import type { JournalIndex } from '../src/journal-segment';
import schema from './schema';
import { canonicalPayload } from '../src/hosted-source-operation';
import { internalMutation, internalQuery } from './server';
import { archiveIndexKind, archiveIndexPageSize, indexArchiveTargets } from './projectPlanningArchiveIndex';

const projectId = v.id('hostedProjects');
const cursor = v.union(v.string(), v.null());
const archiveBackfillPosition = v.object({ legacyRecords: v.boolean(), cursor });
const initial = { legacyRecords: false, cursor: null };
const position = v.union(archiveBackfillPosition, v.null());
const entry = v.object({ key: v.string(), index: v.string() });
const pageResult = v.object({ from: position, next: position, entries: v.array(entry) });

export const page = internalQuery({
  args: { projectId },
  returns: pageResult,
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal || project.planningArchiveIndexed)
      return { from: null, next: null, entries: [] };
    const from = project.planningArchiveBackfill ?? initial;
    // Modern grouped record archives retain indexed headers with their exact segment pointers.
    // Older per-record scopes can predate those headers, so they need sparse references too.
    const source = stream(ctx.db, schema)
      .query('projectJournalSegments')
      .withIndex('by_project_and_scope_and_from', q => {
        const scope = q.eq('projectId', input.projectId);
        return from.legacyRecords
          ? scope.gte('scope', 'record:').lt('scope', 'record;')
          : scope.eq('scope', 'events');
      })
      .narrow({
        lowerBound: from.cursor ? (JSON.parse(from.cursor) as IndexKey) : [],
        lowerBoundInclusive: false,
        upperBound: [],
        upperBoundInclusive: true,
      });
    const entries: { key: string; index: string }[] = [];
    let next: typeof position.type = from.legacyRecords ? null : { legacyRecords: true, cursor: null };
    let last = from.cursor;
    let gets = 0;
    let read = 0;
    let metadataBytes = 0;
    let rawBytes = 0;
    for await (const [row, key, bandwidth] of source.iterWithKeys(true)) {
      if (!row) continue;
      if (row.category === (from.legacyRecords ? 'record' : 'events')) {
        const index = JSON.parse(row.value) as JournalIndex;
        const pins = [index.pointer, ...(index.parts ?? [])];
        const size = pins.reduce((n, pin) => n + pin.rawSize, 0);
        // A single oversized segment still makes progress, on a page of its own.
        if (
          entries.length &&
          (gets + pins.length > archiveIndexPageSize || rawBytes + size > 8 * 1024 * 1024)
        ) {
          next = { ...from, cursor: last };
          break;
        }
        gets += pins.length;
        rawBytes += size;
        entries.push({ key: row.key, index: row.value });
      }
      last = JSON.stringify(key);
      metadataBytes += bandwidth;
      if (++read >= archiveIndexPageSize || metadataBytes >= 256 * 1024) {
        next = { ...from, cursor: last };
        break;
      }
    }
    return { from, next, entries };
  },
});

/** The read-only phase verified immutable bytes. Rewrites preserve the key and only remove Item words. */
export const commit = internalMutation({
  args: {
    projectId,
    from: archiveBackfillPosition,
    next: position,
    entries: v.array(
      v.object({
        key: v.string(),
        targets: v.array(v.object({ kind: archiveIndexKind, itemId: v.string() })),
      }),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal || project.planningArchiveIndexed) return false;
    if (canonicalPayload(project.planningArchiveBackfill ?? initial) !== canonicalPayload(input.from))
      return false;
    for (const { key, targets } of input.entries)
      await indexArchiveTargets(ctx, input.projectId, key, targets);
    await ctx.db.patch(input.projectId, {
      planningArchiveBackfill: input.next ?? undefined,
      ...(input.next === null ? { planningArchiveIndexed: true } : {}),
    });
    return true;
  },
});

export type ArchiveBackfillPage = typeof pageResult.type;
