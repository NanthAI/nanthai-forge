// SPDX-License-Identifier: Apache-2.0
import { planningBriefIntent } from '../src/work-planning-lifecycle';
import type { PlanningItem } from '../src/work-planning-types';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { invariant } from '../src/errors';
import type { BriefInput, BriefRecords, BriefEvent, BriefState } from '../src/agent-brief-types';
import type { Lane, WorkData, WorkView, CheckRun } from '../src/work-types';

export async function hostedBriefRecords(ctx: QueryCtx, project: Doc<'hostedProjects'>, input: BriefInput) {
  const generation = await selectedGeneration(ctx, project);
  invariant(
    generation,
    'WORK_STALE',
    'Prepare this project’s current Work index before reading its briefing.',
  );
  const partition = recordPartition(generation),
    coverage: string[] = [];
  async function page(collection: string, parent?: string) {
    const rows =
      parent === undefined
        ? ctx.db
            .query('projectWorkRecords')
            .withIndex('by_generation_and_collection_and_position', q =>
              q.eq('generationId', partition).eq('collection', collection),
            )
        : ctx.db
            .query('projectWorkRecords')
            .withIndex('by_generation_and_collection_and_parent_and_position', q =>
              q.eq('generationId', partition).eq('collection', collection).eq('parent', parent),
            );
    const values = await rows.order('desc').take(100);
    if (values.length === 100)
      coverage.push(`${collection}: latest 100 indexed records shown; older context may exist.`);
    return values.reverse().map(row => JSON.parse(row.value));
  }
  async function get<T>(collection: string, id?: string): Promise<T | undefined> {
    if (!id) return;
    const row = await record(ctx, partition, collection, id);
    if (!row) return;
    const header = JSON.parse(row.value);
    if (!header.payloadKey) return header as T;
    const parts = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q
          .eq('generationId', partition)
          .eq('collection', `${collection}:payload`)
          .eq('parent', header.payloadKey),
      )
      .take(header.payloadParts);
    invariant(
      parts.length === header.payloadParts,
      'INVALID_WORK_JOURNAL',
      'Briefing record payload is incomplete.',
    );
    const full = JSON.parse(parts.map(row => row.value).join(''));
    return (collection === 'intents' ? { ...full, status: header.status } : full) as T;
  }
  const eventRow = input.messageId
    ? await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', project._id).eq('operationId', input.messageId!),
        )
        .unique()
    : null;
  invariant(!input.messageId || eventRow, 'NOT_FOUND', 'Message or handoff not found in this project.');
  const selectedEvent = eventRow ? briefEvent(eventRow) : undefined;
  const run = await get<CheckRun>('runs', input.runId);
  const view = await get<WorkView>('views', input.viewId ?? run?.viewId);
  const lane = await get<Lane>('lanes', input.laneId ?? selectedEvent?.laneId ?? view?.inputs[0]?.laneId);
  const intentId = input.intentId ?? lane?.intentId ?? view?.intentId ?? selectedEvent?.intentId;
  const storedIntent = await get<WorkData['intents'][number]>('intents', intentId);
  const planning = !storedIntent && intentId ? await get<PlanningItem>('planningItems', intentId) : undefined;
  const intent = storedIntent ?? (planning ? planningBriefIntent(planning) : undefined);
  if (intent) intent.notes = await page('notes', intent.id);
  const views: WorkView[] = view ? [view] : intent ? await page('views', intent.id) : [];
  // View summaries carry input pins but defer details/dependencies. Hydrate selected candidates.
  const hydratedViews: WorkView[] = [];
  for (const item of [...views].reverse()) {
    const full = await get<WorkView>('views', item.id);
    if (full && (!lane || full.inputs.some(i => i.laneId === lane.id))) {
      hydratedViews.unshift(full);
      break;
    }
  }
  const latestView = view ?? hydratedViews.at(-1);
  const runRows: CheckRun[] = run ? [run] : latestView ? await page('runs', latestView.id) : [];
  const latestRun = run ?? (runRows.at(-1) ? await get<CheckRun>('runs', runRows.at(-1)!.id) : undefined);
  const events = selectedEvent ? [selectedEvent] : [];
  const scopes = intentId
    ? await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_intentId', q => q.eq('projectId', project._id).eq('intentId', intentId))
        .order('desc')
        .take(100)
    : [];
  const laneEvents = lane
    ? await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_laneId', q => q.eq('projectId', project._id).eq('laneId', lane.id))
        .order('desc')
        .take(100)
    : [];
  const recentEvents = await ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .order('desc')
    .take(100);
  for (const row of [...scopes, ...laneEvents, ...recentEvents]) {
    const item = briefEvent(row);
    if (item && !events.some(e => e.id === item.id)) events.push(item);
  }
  if ([scopes.length, laneEvents.length, recentEvents.length].includes(100))
    coverage.push(
      'Coordination: latest 100 events per Intent/Lane/project scope examined; older context may exist.',
    );
  const claims = await ctx.db
    .query('projectCoordinationClaims')
    .withIndex('by_project_and_expiresAt', q => q.eq('projectId', project._id).gt('expiresAt', Date.now()))
    .take(500);
  if (claims.length === 500)
    coverage.push('Claims: first 500 active candidates examined; overlap coverage may be incomplete.');
  const channels = await page('channels');
  const hostedChannels = await page('hostedChannels');
  const byName = new Map(channels.map(c => [c.name, { name: c.name, head: c.head ?? null }]));
  for (const c of hostedChannels) byName.set(c.channel, { name: c.channel, head: c.head });
  const records: BriefRecords = {
    intents: intent ? [intent] : [],
    lanes: intentId
      ? [...(lane ? [lane] : []), ...(await page('lanes', intentId)).filter(item => item.id !== lane?.id)]
      : [],
    views: view ? [view] : hydratedViews,
    runs: latestRun ? [latestRun] : [],
    channels: [...byName.values()],
    events,
    claims: claims
      .filter(c => !c.releasedAt)
      .map(c => ({
        id: c.claimId,
        actor: c.actor,
        ...(c.sessionId ? { sessionId: c.sessionId } : {}),
        paths: c.paths,
        ...(c.laneId ? { laneId: c.laneId } : {}),
        ...(c.intentId ? { intentId: c.intentId } : {}),
      })),
  };
  return { records, generation, coverage };
}
export function briefEvent(row: Doc<'projectCoordinationEvents'>): BriefEvent | undefined {
  const c = row.command;
  if (c.kind !== 'message' && c.kind !== 'handoff') return;
  const scope = c.kind === 'message' ? c.context : c;
  return {
    id: row.operationId,
    actor: row.actor,
    kind: c.kind,
    text: c.kind === 'message' ? c.text : c.summary,
    ...(c.kind === 'handoff' ? { head: c.head } : {}),
    ...(scope.laneId ? { laneId: scope.laneId } : {}),
    ...(scope.intentId ? { intentId: scope.intentId } : {}),
    paths: c.kind === 'message' ? (c.context.paths ?? []) : [],
  };
}
export async function readBriefState(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
  head: string,
): Promise<BriefState | undefined> {
  const rows = await ctx.db
    .query('projectBriefingSources')
    .withIndex('by_projectId_and_backupId_and_head_and_part', q =>
      q.eq('projectId', projectId).eq('backupId', backupId).eq('head', head).gt('part', -1),
    )
    .take(1000);
  if (!rows.length) return;
  const first = JSON.parse(rows[0]!.value);
  if (rows.length !== first.parts || rows.some((row, i) => row.part !== i)) return;
  return { parents: first.parents, files: rows.flatMap(row => JSON.parse(row.value).files) };
}

/** Ancestry reads only the small header, not every ancestor's file manifest. */
export async function readBriefParents(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
  head: string,
): Promise<BriefState | undefined> {
  const row = await ctx.db
    .query('projectBriefingSources')
    .withIndex('by_projectId_and_backupId_and_head_and_part', q =>
      q.eq('projectId', projectId).eq('backupId', backupId).eq('head', head).eq('part', -1),
    )
    .unique();
  if (!row) return;
  return { parents: JSON.parse(row.value).parents, files: [] };
}
