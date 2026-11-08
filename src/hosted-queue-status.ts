// SPDX-License-Identifier: Apache-2.0
import { orderLandingEntries } from './landing-batch-order.js';
import type { HostedLandingState } from './hosted-landing.js';
/** Compact ordering metadata, not source or retained submission bodies. */
export type QueueStatusKey = {
  id: string;
  sequence: number;
  actor: string;
  priority: 'normal' | 'urgent';
  phase: 'queued' | 'checking' | 'ready';
  batchId?: string;
  /** Held for a person or a dependency (5c59940b): listed, never ranked or a predecessor. */
  held?: 'review' | 'dependency';
  position?: number;
  group?: number;
  predecessor?: string | undefined;
};
export const QUEUE_STATUS_PAGE_SIZE = 128;
export const queueStatusPage = (sequence: number) => Math.floor(sequence / QUEUE_STATUS_PAGE_SIZE);
const heldReasons: Record<string, QueueStatusKey['held']> = {
  'waiting-for-review': 'review',
  'waiting-for-dependency': 'dependency',
};
/** Every pending landing has a directory entry; a held one is marked, so a reader can say
 * what holds it instead of the entry vanishing from the queue (5c59940b). */
export const queueStatusKey = (state: HostedLandingState): QueueStatusKey | null => {
  if (state.observation.state !== 'pending' || !['queued', 'checking', 'ready'].includes(state.phase))
    return null;
  const held = heldReasons[state.observation.pendingReason ?? ''];
  return {
    id: state.id,
    sequence: state.sequence,
    actor: state.actor,
    priority: state.priority ?? 'normal',
    phase: state.phase as QueueStatusKey['phase'],
    ...(state.batchId ? { batchId: state.batchId } : {}),
    ...(held ? { held } : {}),
  };
};
/** Match the dispatcher ordering; members sharing a check form one service group. */
export function rankQueueStatus(all: QueueStatusKey[]) {
  const keys = all.filter(key => !key.held);
  const held = all
    .filter(key => key.held)
    .sort((a, b) => a.sequence - b.sequence)
    .map(({ position: _position, group: _group, predecessor: _predecessor, ...key }) => key);
  const running = keys.filter(key => key.phase !== 'queued').sort((a, b) => a.sequence - b.sequence);
  const queued = orderLandingEntries(
    keys
      .filter(key => key.phase === 'queued')
      .map(key => ({
        ...key,
        submitter: key.actor,
        arrivedAt: String(key.sequence).padStart(20, '0'),
      })),
  );
  const order: QueueStatusKey[] = [
    ...running,
    ...queued.map(({ submitter: _submitter, arrivedAt: _arrivedAt, ...key }) => key),
  ];
  const groups = new Map<string, number>();
  const leaders: string[] = [];
  for (const [index, key] of order.entries()) {
    const identity = key.batchId ?? key.id;
    let group = groups.get(identity);
    if (group === undefined) {
      group = groups.size + 1;
      groups.set(identity, group);
      leaders.push(key.id);
    }
    key.position = index + 1;
    key.group = group;
    key.predecessor =
      leaders[group - 1] !== key.id ? leaders[group - 1] : group > 1 ? leaders[group - 2] : undefined;
  }
  return {
    /** Dispatch order first, then held entries (no position, group or predecessor). */
    order: [...order, ...held],
    active: order.length,
    held: held.length,
    groups: groups.size,
    runningGroups: new Set(order.filter(key => key.phase !== 'queued').map(key => key.batchId ?? key.id))
      .size,
  };
}
export type HostedQueueStatus = {
  position: number;
  total: number;
  entriesAhead: number;
  groupsAhead: number;
  groupCount: number;
  predecessor: {
    id: string;
    phase: string;
    lastProgressAt: string;
    batchId?: string;
    owner: string | null;
  } | null;
  lastProgressAt: string;
  owner: string | null;
  parallelGroups: number;
  eta: { milliseconds: number; approximate: true; basis: 'recent-service' | 'initial-estimate' };
  message: string;
};
