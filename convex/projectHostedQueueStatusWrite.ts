// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { latestLandingProgress } from '../src/landing-stall';
import {
  queueStatusKey,
  queueStatusPage,
  rankQueueStatus,
  type QueueStatusKey,
} from '../src/hosted-queue-status';
const landingQueue = (ctx: MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', projectId).eq('channel', 'main'))
    .unique();
type QueuePage = Pick<Doc<'projectHostedLandingQueueStatus'>, '_id' | 'page' | 'value'>;
type QueueProjectionMemo = {
  queue?: Doc<'projectHostedLandingQueues'>;
  known: Map<number, QueuePage | undefined>;
  pages?: Map<number, QueuePage>;
};
// Invocation-local only: no authorization, source or queue state survives a
// mutation context. Repeated batch member events reuse one compact directory,
// while every committed event still updates its exact projection atomically.
type ProjectionInvocation = {
  projects: Map<string, QueueProjectionMemo>;
  tail: Promise<void>;
  depth: number;
  pending: Map<string, Map<string, HostedLandingState>>;
};
const projectors = new WeakMap<MutationCtx, ProjectionInvocation>();
function invocationFor(ctx: MutationCtx) {
  let invocation = projectors.get(ctx);
  if (!invocation) {
    invocation = { projects: new Map(), tail: Promise.resolve(), depth: 0, pending: new Map() };
    projectors.set(ctx, invocation);
  }
  return invocation;
}
function retainStatuses(ctx: MutationCtx, states: HostedLandingState[]) {
  const invocation = invocationFor(ctx);
  const projectId = states[0]!.projectId;
  let memo = invocation.projects.get(projectId);
  if (!memo) {
    memo = { known: new Map() };
    invocation.projects.set(projectId, memo);
  }
  const selected = memo;
  const next = invocation.tail.then(() => updateQueueStatus(ctx, states, selected));
  invocation.tail = next;
  return next;
}
export function retainQueueStatus(ctx: MutationCtx, state: HostedLandingState): Promise<void> {
  if (!state.sequence) return Promise.resolve();
  const invocation = invocationFor(ctx);
  if (invocation.depth) {
    let pending = invocation.pending.get(state.projectId);
    if (!pending) invocation.pending.set(state.projectId, (pending = new Map()));
    pending.set(state.id, state);
    return Promise.resolve();
  }
  return retainStatuses(ctx, [state]);
}
/** Existing bounded bulk mutations flush once before commit. This is not a
 * worker or a later write: observers see the state and exact directory atomically. */
export async function withQueueStatusBatch<T>(ctx: MutationCtx, work: () => Promise<T>): Promise<T> {
  const invocation = invocationFor(ctx);
  invocation.depth++;
  let value: T;
  try {
    value = await work();
  } catch (error) {
    if (--invocation.depth === 0) invocation.pending.clear();
    throw error;
  }
  if (--invocation.depth === 0) {
    const pending = [...invocation.pending.values()];
    invocation.pending.clear();
    for (const states of pending) await retainStatuses(ctx, [...states.values()]);
  }
  return value;
}
async function loadPages(ctx: MutationCtx, projectId: Id<'hostedProjects'>, memo: QueueProjectionMemo) {
  if (!memo.pages) {
    const pages: QueuePage[] = [];
    let after = -1;
    for (;;) {
      const window = await ctx.db
        .query('projectHostedLandingQueueStatus')
        .withIndex('by_project_and_page', q => q.eq('projectId', projectId).gt('page', after))
        .order('asc')
        .take(50);
      pages.push(...window);
      if (window.length < 50) break;
      after = window.at(-1)!.page;
    }
    memo.pages = new Map(pages.map(row => [row.page, row]));
  }
  return [...memo.pages.values()];
}
const pageRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, page: number) =>
  ctx.db
    .query('projectHostedLandingQueueStatus')
    .withIndex('by_project_and_page', q => q.eq('projectId', projectId).eq('page', page))
    .unique();
const sameOrder = (a: QueueStatusKey | undefined, b: QueueStatusKey | null) =>
  a?.id === b?.id && a?.phase === b?.phase && a?.batchId === b?.batchId && a?.priority === b?.priority;

/** Maintained by existing committed observation events. Re-ordering costs O(pages)
 * compact metadata reads/writes, never a per-entry RPC or submission-body fan-out.
 * 575/1150 entries use 5/9 pages. Timing-only events touch just the queue clock.
 * Empty pages are removed; no history, source, scheduler or idle work is added. */
async function updateQueueStatus(ctx: MutationCtx, states: HostedLandingState[], memo: QueueProjectionMemo) {
  const projectId = states[0]!.projectId as Id<'hostedProjects'>;
  const queue = memo.queue ?? (await landingQueue(ctx, projectId));
  if (!queue) return;
  memo.queue = queue;
  if (states.length > 1) await loadPages(ctx, projectId, memo);
  const changes = [];
  let clock = queue.status?.lastProgressAt;
  let serviceMs = queue.status?.serviceMs;
  for (const state of states) {
    const page = queueStatusPage(state.sequence);
    let saved = memo.pages ? memo.pages.get(page) : memo.known.get(page);
    if (!memo.pages && !memo.known.has(page)) {
      saved = (await pageRow(ctx, projectId, page)) ?? undefined;
      memo.known.set(page, saved);
    }
    const keys: QueueStatusKey[] = saved ? JSON.parse(saved.value) : [];
    changes.push({ state, previous: keys.find(key => key.id === state.id), next: queueStatusKey(state) });
    if (!queue.status || queue.status.horizon[0] === state.id)
      clock = latestLandingProgress([clock, hostedLandingProgressAt(state)]);
    const service =
      state.phase === 'landed' && state.timing?.selectedAt && state.timing?.committedAt
        ? Date.parse(state.timing.committedAt) - Date.parse(state.timing.selectedAt)
        : 0;
    if (service > 0) serviceMs = Math.round(((serviceMs ?? service) * 3 + service) / 4);
    // A directory fitting this exact page needs no second range read.
    if (queue.status && keys.length === queue.status.total && !memo.pages && saved)
      memo.pages = new Map([[page, saved]]);
  }
  clock ??= hostedLandingProgressAt(states[0]!);
  if (queue.status && changes.every(change => sameOrder(change.previous, change.next))) {
    if (clock !== queue.status.lastProgressAt || serviceMs !== queue.status.serviceMs) {
      const status = { ...queue.status, lastProgressAt: clock, ...(serviceMs ? { serviceMs } : {}) };
      await ctx.db.patch(queue._id, { status });
      memo.queue = { ...queue, status };
    }
    return;
  }
  const pages = await loadPages(ctx, projectId, memo);
  const all: QueueStatusKey[] = pages.flatMap(row => JSON.parse(row.value));
  // Lazy upgrade of the derived queue directory on its first mutation. Reads
  // never initialize it or scan the old queue. No historical/terminal rows.
  if (!queue.status) {
    for (const phase of ['queued', 'checking', 'ready'] as const) {
      let sequence = -1;
      for (;;) {
        const window = await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', projectId).eq('channel', 'main').eq('phase', phase).gt('sequence', sequence),
          )
          .order('asc')
          .take(50);
        for (const row of window) {
          const parsed = hostedLandingStateSchema.parse(JSON.parse(row.value));
          const key = queueStatusKey({ ...parsed, priority: row.priority ?? parsed.priority });
          if (key && !all.some(other => other.id === key.id)) all.push(key);
        }
        if (window.length < 50) break;
        sequence = window.at(-1)!.sequence;
      }
    }
  }
  const changed = new Set(states.map(state => state.id));
  const { order, groups, runningGroups } = rankQueueStatus([
    ...all.filter(key => !changed.has(key.id)),
    ...changes.flatMap(change => (change.next ? [change.next] : [])),
  ]);
  const grouped = new Map<number, QueueStatusKey[]>();
  for (const key of order) {
    const bucket = queueStatusPage(key.sequence);
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket)!.push(key);
  }
  for (const row of pages) {
    const entries = grouped.get(row.page);
    if (!entries) {
      await ctx.db.delete(row._id);
      memo.pages!.delete(row.page);
    } else {
      const value = JSON.stringify(entries);
      if (value !== row.value) await ctx.db.patch(row._id, { value });
      memo.pages!.set(row.page, { ...row, value });
      grouped.delete(row.page);
    }
  }
  for (const [bucket, entries] of grouped) {
    const value = JSON.stringify(entries);
    const id = await ctx.db.insert('projectHostedLandingQueueStatus', { projectId, page: bucket, value });
    memo.pages!.set(bucket, { _id: id, page: bucket, value });
  }
  const status = {
    total: order.length,
    groups,
    runningGroups,
    horizon: order.slice(0, 8).map(key => key.id),
    lastProgressAt: clock,
    ...(serviceMs ? { serviceMs } : {}),
  };
  await ctx.db.patch(queue._id, { status });
  memo.queue = { ...queue, status };
}
