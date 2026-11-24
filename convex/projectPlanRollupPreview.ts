// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalQuery } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { workRecordTable } from './projectWorkRecordTables';
import { generationHead } from './projectWorkHead';
import { currentPlanningIntentHead } from './projectPlanningIntentState';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { planningTaskLines, proseDoneWhenLines } from '../src/planning-search';
import { isShelved, planningItemSchema, type PlanningItem } from '../src/work-planning-types';
import type { RollupWork } from '../src/planning-rollup';

// One-time operator tool: bind to the same approved Forge development deployment as storage retirement.
const approvedDev = 'https://benevolent-wildebeest-974.convex.cloud';
const PAGE = 50;
const BYTES = 256 * 1024;
// This budgets operator probes, not the number of Intents an Item can link. An incomplete
// preview cannot be used to write statuses. A later recovery can read exceptional Items individually.
const INTENT_KEYS = 150;
const fence = v.object({ generation: v.id('projectWorkGenerations'), revision: v.number() });
const statuses = planningItemSchema.shape.status.unwrap().options;
const status = v.union(...statuses.map(word => v.literal(word)));

function checklist(body: string) {
  let checked = 0;
  let unchecked = 0;
  let structured = false;
  for (const { match } of planningTaskLines(body.split('\n'))) {
    structured = true; // A moved line is no longer an obligation and needs no tick.
    if (match[2] === ' ') unchecked++;
    else if (match[2] !== '~') checked++;
  }
  // A prose-only Done-when section needs manual review, not a guessed successful tick.
  if (!structured) unchecked += proseDoneWhenLines(body).length;
  return { checked, unchecked };
}

type PreviewRoot = PlanningItem & { payload?: true; payloadKey?: string };

/** An explicitly opted-in, read-only operator page. No stored cursor or scheduler. The Work revision fences
 * planning roots. The preparation/apply pass must recheck workStamp because hosted Intent heads can move
 * without changing that revision. The preview does not authorize an apply. */
export const page = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    after: v.string(),
    expected: v.optional(fence),
  },
  returns: v.object({
    fence,
    from: v.string(),
    after: v.union(v.string(), v.null()),
    rootsRead: v.number(),
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
      process.env.CONVEX_CLOUD_URL === approvedDev,
      'HOSTED_ACTION_UNSUPPORTED',
      'Planning roll-up preview is not enabled on the selected dev deployment.',
    );
    const project = await ctx.db.get(args.projectId);
    const selected = project && !project.removal && (await selectedGeneration(ctx, project));
    invariant(selected, 'PROJECT_WORK_INDEX_MISSING', 'Select a ready project Plan before preview.');
    const generation = await generationHead(ctx, selected);
    invariant(
      args.expected
        ? args.expected.generation === generation._id && args.expected.revision === generation.revision
        : args.after === '',
      'WORK_STALE',
      'Planning changed since the preview started. Do not combine pages across revisions.',
    );
    const partition = recordPartition(generation);
    const source = await ctx.db
      .query(await workRecordTable(ctx, partition, 'planningItems'))
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
    const readHeads = new Map<string, ReturnType<typeof currentPlanningIntentHead>>();
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
        const ids =
          item.kind === 'issue' && !fragmented ? [...new Set([item.id, ...(item.intentIds ?? [])])] : [];
        const supported =
          !fragmented && readHeads.size + ids.filter(id => !readHeads.has(id)).length <= INTENT_KEYS;
        const heads = supported
          ? await Promise.all(
              ids.map(id => {
                let read = readHeads.get(id);
                if (!read) {
                  read = currentPlanningIntentHead(ctx, args.projectId, id);
                  readHeads.set(id, read);
                }
                return read;
              }),
            )
          : [];
        const live = heads.flatMap(head =>
          head && !head.status.startsWith('journal:') ? [head.status] : [],
        );
        const incomplete = !supported || heads.slice(1).some(head => !head);
        const work: RollupWork = incomplete
          ? 'unknown'
          : live.some(s => s !== 'completed' && s !== 'abandoned')
            ? 'active'
            : live.includes('completed')
              ? 'completed'
              : live.length
                ? 'abandoned'
                : 'none';
        return {
          id: item.id,
          kind: item.kind,
          version: item.version,
          status: item.status,
          ...(item.parentId ? { parentId: item.parentId } : {}),
          ...(item.initiativeId ? { initiativeId: item.initiativeId } : {}),
          ...(item.statusPin ? { pinned: true as const } : {}),
          ...(incomplete ? { incomplete: true as const } : {}),
          ...(fragmented ? { checked: 0, unchecked: 1 } : checklist(item.body)),
          work,
          workStamp: digest(
            JSON.stringify(
              heads.map(head => (head ? [head.key, head.recordId, head.version, head.status] : null)),
            ),
          ),
        };
      }),
    );
    return {
      fence: { generation: generation._id, revision: generation.revision },
      from: args.after,
      after: source.isDone ? null : last!,
      rootsRead: source.page.length,
      intentKeys: readHeads.size,
      rows: rows.filter(row => row !== null),
    };
  },
});
