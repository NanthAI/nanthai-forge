// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalQuery } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { workRecordLookup, splitRecordTable } from './projectWorkRecordTables';
import { planCounter, type PlanCounts } from './projectPlanCountsStore';
import { readRollupBranch } from './projectPlanRollupStore';
import { completionHeldByReopen } from './projectPlanRollupReopen';
import { generationHead } from './projectWorkHead';
import { rollupChecklist, rollupWorkReader } from './projectPlanRollupFacts';
import { invariant } from '../src/errors';
import { isShelved, planningItemSchema, type PlanningItem } from '../src/work-planning-types';

// One-time operator tool: bind to the same approved Forge development deployment as storage retirement.
export const approvedDevRollup = 'https://benevolent-wildebeest-974.convex.cloud';
const PAGE = 50;
const BYTES = 256 * 1024;
// This budgets operator probes, not the number of Intents an Item can link. An incomplete
// preview cannot be used to write statuses. A later recovery can read exceptional Items individually.
const INTENT_KEYS = 150;
const fence = v.object({ generation: v.id('projectWorkGenerations'), revision: v.number() });
const statuses = planningItemSchema.shape.status.unwrap().options;
const status = v.union(...statuses.map(word => v.literal(word)));

type PreviewRoot = PlanningItem & { payload?: true; payloadKey?: string };

/** Read-only diagnostic pages share one Plan revision. No stored cursor or scheduler.
 * An exact approved set uses point previews with its own counter and Work pins instead. */
export const page = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    after: v.string(),
    expected: v.optional(fence),
    /** A targeted preview is valid only for a leaf Item with proved scope coverage. */
    itemId: v.optional(v.string()),
  },
  returns: v.object({
    fence,
    from: v.string(),
    after: v.union(v.string(), v.null()),
    rootsRead: v.number(),
    targeted: v.optional(v.literal(true)),
    intentKeys: v.number(),
    rows: v.array(
      v.object({
        id: v.string(),
        kind: v.union(v.literal('issue'), v.literal('initiative')),
        version: v.number(),
        status,
        pinned: v.optional(v.literal(true)),
        checked: v.number(),
        unchecked: v.number(),
        parentId: v.optional(v.string()),
        initiativeId: v.optional(v.string()),
        incomplete: v.optional(v.literal(true)),
        completionHeld: v.optional(v.literal(true)),
        work: v.union(
          v.literal('none'),
          v.literal('active'),
          v.literal('completed'),
          v.literal('abandoned'),
          v.literal('unknown'),
        ),
        workStamp: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    invariant(
      process.env.CONVEX_CLOUD_URL === approvedDevRollup,
      'HOSTED_ACTION_UNSUPPORTED',
      'Planning roll-up preview is not enabled on the selected dev deployment.',
    );
    const project = await ctx.db.get(args.projectId);
    const selected = project && !project.removal && (await selectedGeneration(ctx, project));
    invariant(
      project && selected,
      'PROJECT_WORK_INDEX_MISSING',
      'Select a ready project Plan before preview.',
    );
    const generation = await generationHead(ctx, selected);
    invariant(
      args.expected
        ? args.expected.generation === generation._id && args.expected.revision === generation.revision
        : args.after === '',
      'WORK_STALE',
      'Planning changed since the preview started. Do not combine pages across revisions.',
    );
    const partition = recordPartition(generation);
    const leaf = args.itemId && (await workRecordLookup(ctx, partition, 'planningItems', args.itemId));
    if (args.itemId) {
      const header = await planCounter(ctx.db, partition);
      const counts: PlanCounts | null = header ? JSON.parse(header.value) : null;
      const scope = await readRollupBranch(ctx.db, partition, args.itemId);
      invariant(
        args.after === '' &&
          leaf &&
          JSON.parse(leaf.value).kind === 'issue' &&
          counts?.scopeThrough === null &&
          !counts.scopeBlocked &&
          !scope.counts.total,
        'WORK_STALE',
        'Select a current leaf Item with complete scope coverage for a targeted preview.',
      );
    }
    const source = leaf
      ? { page: [leaf], isDone: true }
      : await ctx.db
          .query(splitRecordTable('planningItems'))
          .withIndex('by_generation_and_collection_and_key', q =>
            q.eq('generationId', partition).eq('collection', 'planningItems').gt('key', args.after),
          )
          .paginate({ cursor: null, numItems: PAGE, maximumRowsRead: PAGE, maximumBytesRead: BYTES });
    const last = source.page.at(-1)?.key;
    invariant(
      source.isDone || (last && last > args.after),
      'WORK_STALE',
      'The bounded preview could not advance.',
    );
    const read = rollupWorkReader(ctx, project, generation, INTENT_KEYS);
    const rows = await Promise.all(
      source.page.map(async row => {
        const item: PreviewRoot = JSON.parse(row.value);
        invariant(
          item.id === row.key &&
            (item.kind === 'issue' || item.kind === 'initiative') &&
            statuses.includes(item.status),
          'WORK_STALE',
          'The bounded preview encountered an unreadable planning root.',
        );
        if (isShelved(item.status) || item.purged) return null;
        // A compact payload may omit both the pin and links. Never interpret that as unpinned or unlinked.
        const fragmented = Boolean(item.payload || item.payloadKey || typeof item.body !== 'string');
        const facts = fragmented ? { work: 'unknown' as const, workStamp: '' } : await read.read(item);
        const { work, workStamp } = facts;
        const completionHeld = await completionHeldByReopen(ctx, args.projectId, partition, item, facts);
        return {
          id: item.id,
          kind: item.kind,
          version: item.version,
          status: item.status,
          ...(item.parentId ? { parentId: item.parentId } : {}),
          ...(item.initiativeId ? { initiativeId: item.initiativeId } : {}),
          ...(item.statusPin ? { pinned: true as const } : {}),
          ...(work === 'unknown' ? { incomplete: true as const } : {}),
          ...(completionHeld ? { completionHeld: true as const } : {}),
          ...(fragmented ? { checked: 0, unchecked: 1 } : rollupChecklist(item.body)),
          work,
          workStamp,
        };
      }),
    );
    return {
      fence: { generation: generation._id, revision: generation.revision },
      from: args.after,
      after: source.isDone ? null : last!,
      rootsRead: source.page.length,
      ...(args.itemId ? { targeted: true as const } : {}),
      intentKeys: read.calls,
      rows: rows.filter(row => row !== null),
    };
  },
});
