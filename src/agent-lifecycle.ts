// SPDX-License-Identifier: Apache-2.0
import { stackStatus, type StackLane } from './agent-stack.js';
import { gitIsAncestor } from './work-git.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { NativeSource } from './native-source.js';
import { ForgeError, invariant } from './errors.js';
import { laneReceipt } from './agent-receipts.js';
import type { WorkService } from './work.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkData } from './work-types.js';

/** Every record of a collection, read page by page without locking. */
export function allRecords<T>(store: WorkStore, collection: string): T[] {
  const result: T[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = store.page(collection, offset, 100) as { records: T[]; nextOffset: number | null };
    result.push(...page.records);
    offset = page.nextOffset;
  }
  return result;
}
type Head = { name: string; head: string };
/** Accepted Channel heads, from data already loaded or (when omitted) read fresh. */
export function channelHeads(store: WorkStore, data?: Pick<WorkData, 'channelMoves'>): Head[] {
  const channels = store.native
    ? nativeChannels((data ?? { channelMoves: allRecords(store, 'channelMoves') }) as WorkData)
    : channelStatus(store, store.load());
  return channels.flatMap(item => (item.head ? [{ name: item.name, head: item.head }] : []));
}
/** A Lane is merged when it has its own work and its head is contained in an accepted Channel head. */
export function mergedChecker(store: WorkStore, heads: Head[]) {
  const native = store.native ? new NativeSource(store.root).ancestry() : undefined;
  return (lane: Pick<Lane, 'head' | 'base'>): string | null => {
    if (lane.head === lane.base) return null;
    for (const item of heads) {
      try {
        if (native ? native.contains(item.head, lane.head) : gitIsAncestor(store.root, lane.head, item.head))
          return item.name;
      } catch {
        // An unreadable head is simply not shown as merged.
      }
    }
    return null;
  };
}
export const mergedFields = (channel: string | null) => ({
  merged: channel !== null,
  ...(channel === null ? {} : { mergedInto: channel }),
});
export function annotateLanes<T extends { head: string; base: string } & StackLane>(
  store: WorkStore,
  items: T[],
  data?: Pick<WorkData, 'channelMoves'>,
) {
  const merged = mergedChecker(store, channelHeads(store, data));
  return items.map(item => ({
    ...item,
    ...mergedFields(merged(item)),
    ...(item.stack ? { stackStatus: stackStatus(store, item) } : {}),
  }));
}

async function setState(work: WorkService, command: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work.dispatch(command, work.store.revision());
    } catch (error) {
      if (!(error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE'].includes(error.code)) || attempt >= 7)
        throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
const OPEN = ['active', 'paused', 'ready'];
type Cleanup = { laneId: string; cleanup: unknown };
async function completeLane(
  work: WorkService,
  lane: Lane,
  skipped: { laneId: string; code: string }[],
  cleanup: Cleanup[] = [],
) {
  if (!OPEN.includes(lane.state)) return lane.state === 'completed';
  try {
    const response = await setState(work, {
      action: 'lane-status',
      laneId: lane.id,
      expectedHead: lane.head,
      state: 'completed',
    });
    if (response.result && typeof response.result === 'object' && 'cleanup' in response.result)
      cleanup.push({ laneId: lane.id, cleanup: response.result.cleanup });
    return true;
  } catch (error) {
    skipped.push({ laneId: lane.id, code: error instanceof ForgeError ? error.code : 'ERROR' });
    return false;
  }
}
/** Complete the Intent when every one of its Lanes is completed. */
async function completeIntent(work: WorkService, intentId: string) {
  const store = work.store,
    intent = store.select('intents', intentId);
  if (!intent || !['active', 'ready'].includes(intent.status)) return false;
  const lanes = allRecords<Lane>(store, 'lanes').filter(lane => lane.intentId === intentId);
  if (!lanes.length || lanes.some(lane => lane.state !== 'completed')) return false;
  await setState(work, { action: 'intent-status', intentId, status: 'completed' });
  return true;
}
/** Mark the Lanes that fed an accepted View, and their Intent, completed. Retry-safe. */
export async function completeAccepted(work: WorkService, viewId: string) {
  const store = work.store,
    view = store.select('views', viewId);
  if (!view) return { lanes: [], intent: false, skipped: [] };
  const skipped: { laneId: string; code: string }[] = [],
    cleanup: Cleanup[] = [],
    lanes: string[] = [];
  const inputs = new Map<string, { laneId: string; head: string }>();
  const visited = new Set<string>();
  const collect = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const candidate = store.select('views', id);
    if (!candidate) return;
    for (const pin of candidate.inputs) inputs.set(`${pin.laneId}:${pin.head}`, pin);
    for (const pin of candidate.dependencies ?? []) if (pin.kind === 'view') collect(pin.viewId);
    if (candidate.resolution) collect(candidate.resolution.viewId);
  };
  collect(viewId);
  const intents = new Set<string>();
  for (const input of inputs.values()) {
    const lane = store.select('lanes', input.laneId, 'id', true);
    if (lane) intents.add(lane.intentId);
    if (lane && lane.head !== input.head) skipped.push({ laneId: lane.id, code: 'LANE_STALE' });
    else if (lane && (await completeLane(work, lane, skipped, cleanup))) lanes.push(lane.id);
  }
  for (const intentId of intents) await completeIntent(work, intentId);
  const intent = store.select('intents', view.intentId)?.status === 'completed';
  return {
    lanes,
    intent: intent || store.select('intents', view.intentId)?.status === 'completed',
    skipped,
    ...(cleanup.length ? { cleanup } : {}),
  };
}
/** Explicit sweep: complete every open Lane already contained in a Channel, then finished Intents. */
export async function completeMerged(work: WorkService, channel = 'main') {
  const store = work.store,
    head = channelHeads(store).find(item => item.name === channel);
  invariant(head, 'NOT_FOUND', 'Channel has no accepted head.');
  const merged = mergedChecker(store, [head]),
    skipped: { laneId: string; code: string }[] = [],
    lanes: string[] = [],
    cleanup: Cleanup[] = [],
    intents: string[] = [],
    candidates = new Set<string>();
  for (const lane of allRecords<Lane>(store, 'lanes')) {
    if (!merged(lane)) continue;
    candidates.add(lane.intentId);
    if (OPEN.includes(lane.state) && (await completeLane(work, lane, skipped, cleanup))) lanes.push(lane.id);
  }
  for (const intentId of candidates) if (await completeIntent(work, intentId)) intents.push(intentId);
  return { channel, head: head.head, lanes, intents, skipped, ...(cleanup.length ? { cleanup } : {}) };
}
/** `complete`/`reopen` for one Lane or Intent, without a hand-fetched revision. */
export async function setLifecycle(
  work: WorkService,
  command: { laneId?: string | undefined; intentId?: string | undefined },
  completed: boolean,
) {
  const store = work.store;
  invariant(!command.laneId !== !command.intentId, 'BAD_ARGUMENT', 'Send either laneId or intentId.');
  if (command.laneId) {
    const response = await setState(work, {
      action: 'lane-status',
      laneId: command.laneId,
      state: completed ? 'completed' : 'active',
    });
    const lane = store.select('lanes', command.laneId, 'id', true)!;
    return {
      revision: response.revision,
      result: {
        ...laneReceipt(lane, store.path(lane.id)),
        ...('cleanup' in (response.result as object)
          ? { cleanup: (response.result as { cleanup: unknown }).cleanup }
          : {}),
      },
    };
  }
  const response = await setState(work, {
    action: 'intent-status',
    intentId: command.intentId,
    status: completed ? 'completed' : 'active',
  });
  const intent = store.select('intents', command.intentId!, 'id', true)!;
  return {
    revision: response.revision,
    result: { intentId: intent.id, outcome: intent.outcome, status: intent.status },
  };
}
