// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation } from './server';
import { invariant } from '../src/errors';
import { hostedRecordValue } from '../src/hosted-records';
import { digest } from '../src/state/hash';
import { workStoreRecord } from '../src/work-store-records';
import { archiveSegmentRow, indexArchiveTargets } from './projectPlanningArchiveIndex';
import { legacyVersionValue, planningHistoryBudget } from './projectPlanningHistory';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';

const pageSize = 16;
const pageBytes = 256 * 1024;
const versionPin = v.object({
  key: v.string(),
  version: v.number(),
  digest: v.string(),
  bytes: v.number(),
  segment: v.string(),
});
type Pin = typeof versionPin.type;
const versionKey = (key: string, version: number) => JSON.stringify([key, version]);
const exact = (row: Doc<'projectHostedRecords'>, pin: Pin) =>
  row.digest === pin.digest && row.bytes === pin.bytes && row.purged === undefined;

/** Restore exact Issue bytes formerly placed in generic journal archives. Keep the existing archive's
 * purge reachability before dropping its header marker. Only the bounded dev operator calls this.
 * @remove-after 2026-12-31
 */
export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    cursor: v.union(v.string(), v.null()),
    pins: v.array(versionPin),
    apply: v.boolean(),
  },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    scanned: v.number(),
    matched: v.array(v.object({ key: v.string(), version: v.number() })),
    changed: v.number(),
  }),
  handler: async (ctx, { projectId, generationId, cursor, pins, apply }) => {
    const project = await ctx.db.get(projectId);
    const generation = project && !project.removal ? await selectedGeneration(ctx, project) : null;
    invariant(
      project &&
        generation &&
        recordPartition(generation) === generationId &&
        !project.itemPurges?.some(purge => purge.purgedAt === undefined),
      'WORK_STALE',
      'The verified Work partition or purge state changed.',
    );
    const expected = new Map(pins.map(pin => [versionKey(pin.key, pin.version), pin]));
    invariant(expected.size === pins.length, 'BAD_ARGUMENT', 'Each Issue version pin must be unique.');
    const source = await ctx.db
      .query('projectWorkDataRecords')
      .withIndex('by_generation_and_collection_and_position', q =>
        q.eq('generationId', generationId).eq('collection', 'planningVersions'),
      )
      .paginate({ cursor, numItems: pageSize, maximumRowsRead: pageSize, maximumBytesRead: pageBytes });
    const snapshots = planningHistoryBudget(1024 * 1024);
    const matched: Pin[] = [];
    let changed = 0;
    for (const original of source.page) {
      const { version, operationId, purged } = JSON.parse(original.value);
      const pin = expected.get(versionKey(original.parent, version));
      if (!pin) continue;
      invariant(
        original.projectId === projectId && operationId === original.key && !purged,
        'WORK_STALE',
        'The retained Issue version differs from its verified pin.',
      );
      const header = await ctx.db
        .query('projectHostedRecords')
        .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
          q
            .eq('projectId', projectId)
            .eq('kind', 'issue')
            .eq('key', pin.key)
            .eq('version', pin.version)
            .eq('lifecyclePlanId', undefined),
        )
        .unique();
      invariant(
        header?.kind === 'issue' && exact(header, pin),
        'WORK_STALE',
        'The canonical Issue header changed.',
      );
      // A retry of a committed page validates exact bytes and writes nothing.
      const body = await ctx.db.get(header.bodyId);
      const local = header.inline ?? body?.value;
      invariant(
        !body || body.projectId === projectId,
        'WORK_STALE',
        'The Issue body belongs to another project.',
      );
      if (header.journalSegment === undefined) {
        invariant(
          local && digest(local) === pin.digest && new TextEncoder().encode(local).length === pin.bytes,
          'WORK_STALE',
          'The restored Issue bytes differ from their verified pin.',
        );
        matched.push(pin);
        continue;
      }
      invariant(
        header.journalSegment === pin.segment && (await archiveSegmentRow(ctx, projectId, pin.segment)),
        'WORK_STALE',
        'The Issue archive pin changed.',
      );
      invariant(snapshots.record(original), 'WORK_STALE', 'The selected Issue page exceeds its byte budget.');
      const value = await legacyVersionValue(ctx, generationId, original, snapshots);
      invariant(value !== null, 'WORK_STALE', 'The retained Issue snapshot is incomplete.');
      const item = JSON.parse(value);
      const encoded = hostedRecordValue(workStoreRecord('planningVersions', item));
      invariant(
        item.id === pin.key &&
          item.operationId === original.key &&
          item.version === pin.version &&
          item.purged === undefined &&
          encoded.ref.digest === pin.digest &&
          encoded.ref.bytes === pin.bytes,
        'WORK_STALE',
        'The retained Issue bytes differ from the canonical archive pin.',
      );
      invariant(
        !body ||
          (body.operationId === undefined
            ? body.value === encoded.value
            : body.operationId === original.key && (!body.value || body.value === encoded.value)),
        'WORK_STALE',
        'The existing Issue body differs from its retained version.',
      );
      // The audit reads version one's timestamp from its inline body. Work provenance bodies also
      // keep their existing command and use the ordinary inline layout for the Issue value.
      const inline = header.version === 1 || body?.operationId !== undefined;
      invariant(
        !inline || getDocumentSize({ ...header, inline: encoded.value }) < 1024 * 1024,
        'WORK_STALE',
        'The exact Issue snapshot does not fit its canonical header.',
      );
      matched.push(pin);
      if (!apply) continue;
      const bodyId =
        body?._id ??
        (await ctx.db.insert('projectHostedRecordBodies', { projectId, value: inline ? '' : encoded.value }));
      await indexArchiveTargets(ctx, projectId, pin.segment, [{ kind: 'issue', itemId: pin.key }]);
      await ctx.db.patch(header._id, {
        kind: 'issue',
        bodyId,
        inline: inline ? encoded.value : undefined,
        journalSegment: undefined,
      });
      changed++;
    }
    return {
      cursor: source.isDone ? null : source.continueCursor,
      scanned: source.page.length,
      matched: matched.map(({ key, version }) => ({ key, version })),
      changed,
    };
  },
});
