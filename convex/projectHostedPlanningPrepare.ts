// SPDX-License-Identifier: Apache-2.0
import { workRecordTable } from './projectWorkRecordTables';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './server';
import { finishWorkRecordWrites } from './projectWorkRecordWriter';
import { ensurePlanProjectHeader } from './projectPlanHeaderStore';
import { accessibleProject } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningSearchEntries, planningSearchRowBytes, planningSummary } from '../src/planning-search';
import { namedPathsField } from '../src/work-schedule';
import { assembleIndexValue } from '../src/work-index-value';
import type { PlanningItem } from '../src/work-planning-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';

/** Explicit operator preparation for pre-search generations. One page/operation, no scheduler,
 * source bytes, R2 reads, full Work reconstruction, or query-triggered backfill. */
export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    operationId: v.string(),
    cursor: v.union(v.string(), v.null()),
    /** Rebuild only compact Plan pages from an already complete search projection. */
    planRowsOnly: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await accessibleProject(ctx, input.projectId, input.owner);
    invariant(
      project.owner === input.owner,
      'PROJECT_UNAVAILABLE',
      'Only the owner prepares planning search.',
    );
    invariant(
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
      'BAD_ARGUMENT',
      'Use an original operation UUID.',
    );
    const pinned = await ctx.db.get(input.generationId);
    invariant(
      pinned?.projectId === input.projectId,
      'PROJECT_UNAVAILABLE',
      'Select this project’s generation.',
    );
    const partition = recordPartition(pinned);
    const request = digest(canonicalPayload(input));
    const previous = await record(ctx, partition, 'planningSearchPreparation', input.operationId);
    if (previous) {
      const saved = JSON.parse(previous.value);
      invariant(saved.request === request, 'WORK_OPERATION_CHANGED', 'Replay the original preparation page.');
      return canonicalPayload(saved.result);
    }
    const generation = await selectedGeneration(ctx, project);
    invariant(
      generation?._id === input.generationId,
      'WORK_STALE',
      'Restart preparation for the current generation.',
    );
    if (input.cursor === null) {
      await ensurePlanProjectHeader(ctx, project);
      await ctx.db.patch(partition, { planRowsVersion: undefined, planRowsOversized: undefined });
      if (partition !== generation._id) await ctx.db.patch(generation._id, { planRowsVersion: undefined });
    }
    if (input.planRowsOnly) {
      invariant(
        generation.planningSearchVersion === 2,
        'WORK_INDEX_REBUILD_REQUIRED',
        'Prepare the complete planning search before its compact Plan pages.',
      );
      let after: string | null = null;
      let compactReady = true;
      if (input.cursor !== null) {
        let cursor: { after?: unknown; operationId?: unknown } | null = null;
        try {
          cursor = JSON.parse(input.cursor);
        } catch {
          invariant(false, 'BAD_ARGUMENT', 'Use the returned Plan preparation cursor.');
        }
        invariant(
          cursor !== null &&
            typeof cursor === 'object' &&
            typeof cursor.after === 'string' &&
            typeof cursor.operationId === 'string',
          'BAD_ARGUMENT',
          'Use the returned Plan preparation cursor.',
        );
        const prior = await record(
          ctx,
          partition,
          'planningSearchPreparation',
          cursor!.operationId as string,
        );
        invariant(
          prior && JSON.parse(prior.value).result.nextCursor === input.cursor,
          'WORK_STALE',
          'Use the returned Plan preparation cursor for this generation.',
        );
        after = cursor!.after as string;
        compactReady = JSON.parse(prior!.value).result.compactReady !== false;
      }
      const page = await ctx.db
        .query(await workRecordTable(ctx, partition, 'planningSearch'))
        .withIndex('by_generation_and_collection_and_key', q => {
          const range = q.eq('generationId', partition).eq('collection', 'planningSearch');
          return after === null ? range : range.gt('key', after);
        })
        .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 1000000 });
      // The common writer repairs the companion without changing canonical root bytes or versions.
      for (const root of page.page) await ctx.db.patch(root._id, { value: root.value });
      compactReady = (await finishWorkRecordWrites(ctx)) !== false && compactReady;
      if (page.isDone && (await ctx.db.get(partition))?.planRowsOversized) compactReady = false;
      if (page.isDone && compactReady) {
        await ctx.db.patch(partition, { planRowsVersion: 1 });
        if (partition !== generation._id) await ctx.db.patch(generation._id, { planRowsVersion: 1 });
      }
      const result = {
        processed: page.page.length,
        nextCursor: page.isDone
          ? null
          : canonicalPayload({ after: page.page.at(-1)?.key ?? after, operationId: input.operationId }),
        isDone: page.isDone,
        compactReady,
      };
      await ctx.db.insert('projectWorkRecords', {
        projectId: input.projectId,
        generationId: partition,
        collection: 'planningSearchPreparation',
        key: input.operationId,
        parent: '',
        position: 0,
        value: canonicalPayload({ request, result }),
      });
      return canonicalPayload(result);
    }
    let selection: { key: string; offset: number; version?: number; compactReady?: boolean } | null = null;
    if (input.cursor !== null) {
      try {
        selection = JSON.parse(input.cursor);
      } catch {
        invariant(false, 'BAD_ARGUMENT', 'Use the returned preparation cursor.');
      }
      invariant(
        selection &&
          typeof selection.key === 'string' &&
          Number.isInteger(selection.offset) &&
          selection.offset >= 0,
        'BAD_ARGUMENT',
        'Use the returned preparation cursor.',
      );
    }
    const rows = await ctx.db
      .query(await workRecordTable(ctx, partition, 'planningItems'))
      .withIndex('by_generation_and_collection_and_key', q => {
        const range = q.eq('generationId', partition).eq('collection', 'planningItems');
        return !selection
          ? range
          : selection.offset
            ? range.gte('key', selection.key)
            : range.gt('key', selection.key);
      })
      .paginate({ cursor: null, numItems: 20, maximumRowsRead: 20, maximumBytesRead: 1000000 });
    let processed = 0,
      bytes = 0,
      written = 0;
    let cursor = input.cursor;
    let completePage = true;
    for (const row of rows.page) {
      const header = JSON.parse(row.value);
      const offset = selection?.offset && selection.key === row.key ? selection.offset : 0;
      invariant(
        !offset || selection?.version === header.version,
        'WORK_STALE',
        'Planning changed during preparation. Restart with cursor:null.',
      );
      const parts = header.payloadKey
        ? await ctx.db
            .query(await workRecordTable(ctx, partition, 'planningItems:payload'))
            .withIndex('by_generation_and_collection_and_parent_and_position', q =>
              q
                .eq('generationId', partition)
                .eq('collection', 'planningItems:payload')
                .eq('parent', header.payloadKey),
            )
            .take(100)
        : [];
      invariant(
        !header.payloadKey || parts.length === header.payloadParts,
        'WORK_INDEX_REBUILD_REQUIRED',
        'This legacy payload needs the existing paged Work-index rebuild. Source remains retained.',
      );
      const item = assembleIndexValue('planningItems', header, parts) as PlanningItem;
      const entries = planningSearchEntries(item, row.position);
      let next = offset;
      for (; next < entries.length; next++) {
        const entry = entries[next]!;
        const size = planningSearchRowBytes(entry);
        if (bytes + size > 4000000) break;
        const old = await record(ctx, partition, entry.collection, entry.key);
        if (old) {
          if (entry.collection === 'planningSearch') {
            const oldPayload = JSON.parse(old.value).payloadKey;
            if (oldPayload && oldPayload !== JSON.parse(entry.value).payloadKey)
              await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retirePayload, {
                projectId: input.projectId,
                generationId: partition,
                collection: entry.collection,
                key: entry.key,
                payloadKey: oldPayload,
              });
          }
          await ctx.db.patch(old._id, entry);
        } else
          await ctx.db.insert('projectWorkRecords', {
            ...entry,
            projectId: input.projectId,
            generationId: partition,
          });
        bytes += size;
        written++;
      }
      if (next < entries.length) {
        cursor = canonicalPayload({ key: row.key, offset: next, version: item.version });
        completePage = false;
        break;
      }
      if (header.payloadKey) {
        const summary = planningSummary(item);
        await ctx.db.patch(row._id, {
          value: canonicalPayload({
            ...header,
            bodyLength: summary.bodyLength,
            hasDoneWhen: summary.hasDoneWhen,
            ...namedPathsField(`${item.title}\n${item.body}`),
          }),
        });
      }
      processed++;
      cursor = canonicalPayload({ key: row.key, offset: 0 });
      // Hydrate only one payload-bearing item per operation, keeping reads below V8 limits.
      if (header.payloadKey) {
        completePage = processed === rows.page.length;
        break;
      }
    }
    const done = rows.isDone && completePage && processed === rows.page.length;
    const flushed = await finishWorkRecordWrites(ctx);
    const compactReady =
      flushed !== false &&
      selection?.compactReady !== false &&
      !(done && (await ctx.db.get(partition))?.planRowsOversized);
    if (cursor) cursor = canonicalPayload({ ...JSON.parse(cursor), compactReady });
    if (done) {
      await ctx.db.patch(generation._id, {
        planningSearchVersion: 2,
        planRowsVersion: compactReady ? 1 : undefined,
      });
      if (partition !== generation._id)
        await ctx.db.patch(partition, { planRowsVersion: compactReady ? 1 : undefined });
    }
    const result = {
      processed,
      written,
      indexedBytes: bytes,
      nextCursor: done ? null : cursor,
      isDone: done,
      compactReady,
    };
    await ctx.db.insert('projectWorkRecords', {
      projectId: input.projectId,
      generationId: partition,
      collection: 'planningSearchPreparation',
      key: input.operationId,
      parent: '',
      position: 0,
      value: canonicalPayload({ request, result }),
    });
    return canonicalPayload(result);
  },
});
