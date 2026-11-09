// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { processAlive } from './local-process.js';
import { LANDING_DROP_MS } from './landing-stall.js';
import type { TurnWork } from './agent-turn-work.js';

/** A ledger entry observed this recently needs no hosted confirmation. */
export const TURN_WORK_WARM_MS = 30_000;
/** A dead observer whose last observation is older than the landing queue's own maximum
 * life (a pending landing with no progress is dropped after this long) cannot be live
 * work any more: the entry is pruned. */
export const TURN_WORK_STALE_MS = LANDING_DROP_MS;

/** What the turn ledger knows about one entry (SM-C M1). Derived at read time; never stored.
 * `watched`: a live observer the client wakes the agent from. `observed`: a live observer.
 * `warm`: seen lately, no observer. `cold`: needs one hosted probe. `stale`: nothing can be
 * confirmed or waited on any more (root gone, or a dead observer past the queue's life). */
export type TurnEntryState = 'watched' | 'observed' | 'warm' | 'cold' | 'stale';
const entryStates = {
  watched: { label: 'watched', nextStep: 'Nothing to do: its observer wakes you when it settles.' },
  observed: { label: 'observed', nextStep: 'Run its wait in the foreground until it settles.' },
  warm: { label: 'recently seen', nextStep: 'Run its wait in the foreground until it settles.' },
  cold: { label: 'unconfirmed', nextStep: 'Confirm it with one hosted read, then wait or forget it.' },
  stale: { label: 'stale', nextStep: 'Forget it: no observer, and past the queue life or its root is gone.' },
} satisfies Record<TurnEntryState, { label: string; nextStep: string }>;

/** The observer is a live Forge process with the recorded start identity: a reused pid is not one. */
export const turnObserverAlive = (work: Pick<TurnWork, 'pid' | 'startTime'>) =>
  work.pid !== null && processAlive({ pid: work.pid, startTime: work.startTime });
/** Cheap checks first: the process is inspected only for an entry old enough to be stale. */
export function turnEntryStale(work: TurnWork, now: number) {
  if (!existsSync(work.root)) return true;
  return now - work.observedAt > TURN_WORK_STALE_MS && !turnObserverAlive(work);
}
export function turnEntryState(work: TurnWork, now: number): TurnEntryState {
  if (turnEntryStale(work, now)) return 'stale';
  if (turnObserverAlive(work)) return work.wake === 'trusted' ? 'watched' : 'observed';
  return now - work.observedAt < TURN_WORK_WARM_MS ? 'warm' : 'cold';
}
export function turnEntry(work: TurnWork, now: number) {
  const state = turnEntryState(work, now);
  return { state, ...entryStates[state] };
}
