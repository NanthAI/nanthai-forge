// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { logIoAttribution } from './ioAttribution';
import { splitRecordTable, planningRecordTable } from './projectWorkRecordTables';
import { v } from 'convex/values';
import type { QueryCtx, MutationCtx } from './server';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { planningIdPrefix, planningSearchTerms } from '../src/planning-search';
import { workHead } from './projectWorkHead';
import { invariant } from '../src/errors';
import { report } from './errors';
import { readProjectRole } from './projectAuthority';
import { planningHistoryBudget, withPlanningTimes } from './projectPlanningHistory';
import type { Doc } from './_generated/dataModel';

export const searchFields = {
  text: v.string(),
  omittedTerms: v.number(),
  status: v.union(
    v.literal('active'),
    v.literal('all'),
    v.literal('open'),
    v.literal('proposed'),
    v.literal('in-progress'),
    v.literal('closed'),
    v.literal('abandoned'),
    v.literal('archived'),
    v.literal('deleted'),
  ),
  kind: v.optional(v.union(v.literal('issue'), v.literal('initiative'))),
  initiativeId: v.optional(v.string()),
  cursor: v.union(v.string(), v.null()),
  limit: v.number(),
};
type Input = {
  text: string;
  omittedTerms: number;
  status: string;
  kind?: 'issue' | 'initiative';
  initiativeId?: string;
  cursor: string | null;
  limit: number;
};

/** Reused inside a filing mutation: no additional external Convex call. Ordinary rows need no per-match lookup. */
export async function searchPlanning(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  input: Input,
  allowMissing = false,
  byId = false,
  planningHistory = false,
) {
  invariant(
    Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 100,
    'BAD_ARGUMENT',
    'limit must be between 1 and 100.',
  );
  const generation = await selectedGeneration(ctx, project);
  if (!generation && allowMissing)
    return {
      items: [],
      coverage: 'unavailable',
      code: 'PROJECT_WORK_INDEX_MISSING',
    };
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'The Work index is unavailable.');
  const { cursor: supplied, ...selection } = input;
  const binding = digest(
    canonicalPayload({
      projectId: project._id,
      generationId: generation._id,
      partition: recordPartition(generation),
      ...selection,
    }),
  );
  let cursor: string | null = null;
  let passed = 0;
  if (supplied !== null) {
    let parsed;
    try {
      parsed = JSON.parse(supplied);
    } catch {
      invariant(false, 'BAD_ARGUMENT', 'Use the returned search cursor.');
    }
    invariant(
      parsed?.binding === binding && typeof parsed.cursor === 'string',
      'WORK_STALE',
      'Search selection or Work generation changed. Restart this search.',
    );
    cursor = parsed.cursor;
    // A cursor from before rows were counted never suppresses anything.
    passed = typeof parsed.read === 'number' ? parsed.read : Number.POSITIVE_INFINITY;
  }
  const searchTable = await planningRecordTable(ctx, recordPartition(generation));
  const matching = (itemId?: string, payloadKey?: string) =>
    ctx.db.query(searchTable).withSearchIndex('search_planning', q => {
      let search = q.search('planning.text', input.text).eq('generationId', recordPartition(generation));
      if (input.status === 'active') search = search.eq('planning.open', true);
      else if (input.status !== 'all') search = search.eq('planning.status', input.status);
      if (input.kind) search = search.eq('planning.kind', input.kind);
      if (input.initiativeId) search = search.eq('planning.initiativeId', input.initiativeId);
      if (itemId) search = search.eq('planning.itemId', itemId);
      if (payloadKey) search = search.eq('planning.payloadKey', payloadKey);
      return search;
    });
  const page = input.text
    ? await matching().paginate({
        cursor,
        numItems: input.limit,
        maximumRowsRead: 100,
        maximumBytesRead: 512000,
      })
    : { page: [], isDone: true, continueCursor: '' };
  const items: unknown[] = [];
  // An id (8-character prefix or full UUID) names its item: it leads the first page, one indexed
  // range read, before text mentions of that id. Other queries read nothing extra.
  const idPrefix = byId && supplied === null ? planningIdPrefix(input.text) : undefined;
  const named = new Set<string>();
  if (idPrefix) {
    const rows = await ctx.db
      .query(splitRecordTable('planningSearch'))
      .withIndex('by_generation_and_collection_and_key', q =>
        q
          .eq('generationId', recordPartition(generation))
          .eq('collection', 'planningSearch')
          .gte('key', idPrefix)
          .lt('key', `${idPrefix}\uffff`),
      )
      .take(5);
    for (const row of rows) {
      const summary = JSON.parse(row.value);
      const open = ['proposed', 'open', 'in-progress'].includes(summary.status);
      if (
        (input.status === 'active' ? !open : input.status !== 'all' && summary.status !== input.status) ||
        (input.kind && summary.kind !== input.kind) ||
        (input.initiativeId && summary.initiativeId !== input.initiativeId)
      )
        continue;
      delete summary.payloadKey;
      delete summary.payloadParts;
      named.add(summary.id);
      items.push({ ...summary, matchedBy: 'id' });
    }
  }
  // An exact multi-word title ranks first across pages. The first 100 matching rows are the promotion
  // window: when the first page is not the whole result and holds no such title, one bounded read of
  // that window (summaries only, no per-row lookup) finds one; the cursor records rows already passed
  // so later pages inside the window skip those titles. Single words and later pages read nothing extra.
  const titled = (summary: { title?: string }) =>
    ` ${
      (summary.title ?? '')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.join(' ') ?? ''
    } `.includes(` ${input.text} `);
  const promoting = input.text.includes(' ') && !input.omittedTerms;
  let tracking = supplied !== null && Number.isFinite(passed);
  const representatives = new Map<string, { best?: string; summary?: unknown }>();
  // A single representative per item/query keeps items unique across cursor pages
  // without retaining an unbounded seen-ID list. Retired fragments never match a current root.
  for (const [index, row] of page.page.entries()) {
    const { itemId, payloadKey } = row.planning ?? {};
    if (!itemId || !payloadKey) {
      const summary = JSON.parse(row.value);
      // Inside the first-page window this title was already promoted there.
      if (!(tracking && supplied !== null && passed + index < 100 && byId && promoting && titled(summary)))
        items.push(summary);
      continue;
    }
    const identity = `${itemId}:${payloadKey}`;
    if (!representatives.has(identity)) {
      const root = await record(ctx, recordPartition(generation), 'planningSearch', itemId);
      const summary = root ? JSON.parse(root.value) : null;
      if (summary?.payloadKey !== payloadKey) representatives.set(identity, {});
      else {
        const [best] = await matching(itemId, payloadKey).take(1);
        const preview = { ...summary };
        delete preview.payloadKey;
        delete preview.payloadParts;
        representatives.set(identity, { best: best?._id, summary: preview });
      }
    }
    const selected = representatives.get(identity)!;
    if (selected.best === row._id && !named.has(itemId)) items.push(selected.summary);
  }
  let lookaheadRows = 0;
  if (byId && promoting && supplied === null && !page.isDone && input.limit < 100) {
    const ordinary = (row: (typeof page.page)[number]) => !row.planning?.itemId;
    if (!page.page.some(row => ordinary(row) && titled(JSON.parse(row.value)))) {
      const window = await matching().take(100);
      lookaheadRows = window.length;
      tracking = true;
      const exact: unknown[] = [];
      const seen = new Set(items.map(item => (item as { id?: string }).id));
      for (const row of window.slice(input.limit)) {
        if (!ordinary(row)) continue;
        const summary = JSON.parse(row.value);
        if (!seen.has(summary.id) && titled(summary)) exact.push({ ...summary, matchedBy: 'title' });
      }
      items.unshift(...exact);
    }
  }
  if (planningHistory) {
    const charge = planningHistoryBudget();
    for (const [index, item] of items.entries())
      items[index] = JSON.parse(
        await withPlanningTimes(ctx, project, recordPartition(generation), JSON.stringify(item), charge),
      );
  }
  return {
    workRevision: (await workHead(ctx, project._id))?.revision ?? project.work?.revision,
    items,
    nextCursor: page.isDone
      ? null
      : canonicalPayload({
          binding,
          cursor: page.continueCursor,
          ...(tracking ? { read: passed + page.page.length } : {}),
        }),
    query: { text: input.text, omittedTerms: input.omittedTerms },
    coverage: generation.planningSearchVersion === 2 ? 'complete' : 'partial-needs-preparation',
    matchedRecordsRead: page.page.length + lookaheadRows,
    matchedRecordBytes: page.page.reduce(
      (sum, row) => sum + new TextEncoder().encode(canonicalPayload(row)).length,
      0,
    ),
  };
}
export const search = query({
  args: { projectId: v.id('hostedProjects'), ...searchFields, planningHistory: v.optional(v.literal(true)) },
  returns: v.string(),
  handler: async (ctx, { projectId, planningHistory, ...input }) => {
    try {
      const { project, actor } = await recordCaller(ctx, projectId);
      const memberHistory = Boolean(planningHistory && (await readProjectRole(ctx, project, actor)));
      return canonicalPayload(await searchPlanning(ctx, project, input, false, true, memberHistory));
    } catch (error) {
      return report(error);
    } finally {
      await logIoAttribution(ctx, 'work-index/search');
    }
  },
});

export async function likelyPlanningDuplicates(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  text: string,
) {
  return searchPlanning(
    ctx,
    project,
    {
      ...planningSearchTerms(text),
      status: 'active',
      kind: 'issue',
      limit: 5,
      cursor: null,
    },
    true,
  );
}
