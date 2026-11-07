// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the Convex non-Node runtime and in test fixtures.
import { digest } from './portable-hash.js';

/** Dependents notified per parent event; a stack is a few levels deep, so this is a safety bound. */
export const STACK_NOTICE_FANOUT = 20;

/** What happened to the parent Lane a stacked Lane is built on (Issue dc62b120). */
export type StackEvent =
  | { kind: 'saved'; head: string }
  /** `key` tells one abandonment from a later one after a reopen (the Lane record version or lifecycle plan). */
  | { kind: 'abandoned'; key: string }
  | { kind: 'landing'; outcome: 'failed' | 'cancelled'; operationId: string; code?: string };

const short = (id: string) => id.slice(0, 8);
const restack = (child: string) => `nforge agent . sync '{"laneId":"${child}"}'`;
const unstack = (child: string) => `nforge agent . sync '{"laneId":"${child}","ontoMain":true}'`;

/** The one-line board note a dependent receives: the event and the exact next command. Under the
 * board's 240-character limit, no machine paths, no names (the sender shows as a Forge handle). */
export function stackNoticeText(event: StackEvent, parentLaneId: string, childLaneId: string) {
  const parent = `Stack: parent Lane ${short(parentLaneId)}`;
  if (event.kind === 'saved')
    return `${parent} saved new work (head ${short(event.head)}). Restack onto it: ${restack(childLaneId)}`;
  if (event.kind === 'abandoned')
    return `${parent} was abandoned. Unstack onto main: ${unstack(childLaneId)}`;
  const what = event.outcome === 'cancelled' ? 'landing was cancelled' : 'landing failed';
  const code = event.code ? ` (${event.code.slice(0, 30)})` : '';
  return `${parent} ${what}${code}. Unstack onto main: ${unstack(childLaneId)}; or restack after its fix: same command without ontoMain`;
}

/** Board message id: a UUID derived from the event, so a replay of the same event writes nothing new. */
export function stackNoticeId(childLaneId: string, parentLaneId: string, key: string) {
  const hex = digest(JSON.stringify(['stack-notice', childLaneId, parentLaneId, key])).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
