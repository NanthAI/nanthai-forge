// SPDX-License-Identifier: Apache-2.0
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
  }
  const matching = (itemId?: string, payloadKey?: string) =>
    ctx.db.query('projectWorkRecords').withSearchIndex('search_planning', q => {
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
      .query('projectWorkRecords')
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
  const representatives = new Map<string, { best?: string; summary?: unknown }>();
  // A single representative per item/query keeps items unique across cursor pages
  // without retaining an unbounded seen-ID list. Retired fragments never match a current root.
  for (const row of page.page) {
    const { itemId, payloadKey } = row.planning ?? {};
    if (!itemId || !payloadKey) {
      items.push(JSON.parse(row.value));
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
  return {
    workRevision: (await workHead(ctx, project._id))?.revision ?? project.work?.revision,
    items,
    nextCursor: page.isDone ? null : canonicalPayload({ binding, cursor: page.continueCursor }),
    query: { text: input.text, omittedTerms: input.omittedTerms },
    coverage: generation.planningSearchVersion === 2 ? 'complete' : 'partial-needs-preparation',
    matchedRecordsRead: page.page.length,
    matchedRecordBytes: page.page.reduce(
      (sum, row) => sum + new TextEncoder().encode(canonicalPayload(row)).length,
      0,
    ),
  };
}
export const search = query({
  args: { projectId: v.id('hostedProjects'), ...searchFields },
  returns: v.string(),
  handler: async (ctx, { projectId, ...input }) => {
    try {
      const { project } = await recordCaller(ctx, projectId);
      return canonicalPayload(await searchPlanning(ctx, project, input, false, true));
    } catch (error) {
      return report(error);
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
