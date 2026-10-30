// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { LandingChannel, LandingRow } from './projectHostedLandingStore';
import type { HostedLandingState } from '../src/hosted-landing';
import { orderLandingEntries } from '../src/landing-batch-order';

export function landingPriority(owner: string, actor: string, requested?: 'urgent' | 'normal') {
  const allowed = owner === actor;
  return {
    priority: requested === 'urgent' && allowed ? ('urgent' as const) : ('normal' as const),
    priorityReason:
      requested === 'urgent'
        ? allowed
          ? 'Urgent requested by the project owner or an agent acting for the owner.'
          : 'Normal: only the project owner or an agent acting for the owner may jump the landing queue.'
        : 'Normal arrival order with fairness within the priority class.',
  };
}
export function landingPriorityState(row: LandingRow, state: HostedLandingState): HostedLandingState {
  return {
    ...state,
    priority: row.priority ?? 'normal',
    priorityReason: row.priorityReason ?? 'Normal arrival order with fairness within the priority class.',
    priorityVersion: row.priorityVersion ?? 0,
  };
}
export function orderHostedLandingRows<T extends Pick<LandingRow, 'sequence' | 'actor' | 'priority'>>(
  rows: T[],
) {
  return orderLandingEntries(
    rows.map(row => ({
      ...row,
      priority: row.priority ?? 'normal',
      submitter: row.actor,
      arrivedAt: String(row.sequence).padStart(20, '0'),
    })),
  );
}
/** Selection of the first entry needs only the head of each indexed class. Old
 * rows without priority belong to normal; no backfill or history scan is needed. */
export async function nextLandingRow(ctx: QueryCtx | MutationCtx, input: LandingChannel) {
  const heads = [];
  for (const priority of ['urgent', 'normal', undefined] as const) {
    const [row] = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_runnable_and_priority_and_sequence', q =>
        q
          .eq('projectId', input.projectId)
          .eq('channel', input.channel)
          .eq('runnable', true)
          .eq('priority', priority),
      )
      .order('asc')
      .take(1);
    if (row) heads.push(row);
    if (priority === 'urgent' && row) break;
  }
  return orderHostedLandingRows(heads)[0] ?? null;
}
/** Read 50-row indexed sequence windows, discarding bodies after each window.
 * Built-in paginate may only be called once per query, so it is not used here. Memory is proportional
 * to the active queue's compact ordering keys, never retained Work/history. No
 * per-entry RPC, scheduler, observer, or total queue-size ceiling is introduced. */
export async function activeLandingOrder(
  ctx: QueryCtx | MutationCtx,
  input: LandingChannel,
  phases: Array<'queued' | 'checking' | 'ready'> = ['queued', 'checking', 'ready'],
  batchable = false,
) {
  const keys: Array<Pick<LandingRow, 'submissionId' | 'actor' | 'sequence' | 'priority' | 'phase'>> = [];
  for (const phase of phases) {
    let after = -1;
    for (;;) {
      const query = batchable
        ? ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_channel_and_batchable_and_phase_and_sequence', q =>
              q
                .eq('projectId', input.projectId)
                .eq('channel', input.channel)
                .eq('batchable', true)
                .eq('phase', phase)
                .gt('sequence', after),
            )
        : ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
              q
                .eq('projectId', input.projectId)
                .eq('channel', input.channel)
                .eq('phase', phase)
                .gt('sequence', after),
            );
      const page = await query.order('asc').take(50);
      for (const row of page)
        keys.push({
          submissionId: row.submissionId,
          actor: row.actor,
          sequence: row.sequence,
          priority: row.priority,
          phase: row.phase,
        });
      if (page.length < 50) break;
      after = page[page.length - 1]!.sequence;
    }
  }
  const running = keys.filter(row => row.phase !== 'queued').sort((a, b) => a.sequence - b.sequence);
  return [...running, ...orderHostedLandingRows(keys.filter(row => row.phase === 'queued'))];
}
export type LandingOrder = Awaited<ReturnType<typeof activeLandingOrder>>;
export async function landingQueuePosition(
  ctx: QueryCtx | MutationCtx,
  state: HostedLandingState,
  selected?: LandingOrder,
) {
  if (state.phase !== 'queued') return null;
  const order =
    selected ??
    (await activeLandingOrder(ctx, {
      projectId: state.projectId as LandingChannel['projectId'],
      channel: 'main',
    }));
  const position = order.findIndex(row => row.submissionId === state.id);
  return position < 0 ? null : position + 1;
}

/** Released wait/stack readers parse submission bodies strictly. Keep their
 * original read shape unless the caller explicitly selects priority metadata. */
export function landingStateForReader(state: HostedLandingState, priorityInfo?: 1): HostedLandingState {
  // Retry links remain in canonical records and admission receipts. Selected
  // read DTOs keep the released strict shape, including priority-aware readers.
  const { supersedes: _supersedes, retryReason: _retryReason, ...publicState } = state;
  const { retryReason: _requestedRetry, ...publicRequest } = state.request;
  void _supersedes;
  void _retryReason;
  void _requestedRetry;
  const readable = { ...publicState, request: publicRequest };
  if (priorityInfo === 1) return readable;
  const { priority: _priority, priorityReason: _reason, priorityVersion: _version, ...legacy } = readable;
  const { priority: _requested, ...request } = readable.request;
  void _priority;
  void _reason;
  void _version;
  void _requested;
  return { ...legacy, request };
}
