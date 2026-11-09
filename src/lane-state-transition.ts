// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { Lane } from './work-types.js';

type LaneState = Lane['state'];
/** The Lane states `lane-status` (complete, reopen, pause, ready) may move between (SM-C M10).
 * `creating` is left only by materialization; `abandoned` only reopens (to active); `completed`
 * only reopens. A state onto itself is a replay and always allowed. */
export const LANE_STATUS_TRANSITIONS = {
  creating: [],
  active: ['paused', 'ready', 'completed'],
  paused: ['active', 'ready', 'completed'],
  ready: ['active', 'paused', 'completed'],
  completed: ['active'],
  abandoned: ['active'],
} as const satisfies Record<LaneState, readonly LaneState[]>;

export function assertLaneStatusTransition(from: LaneState, to: LaneState) {
  const legal: readonly LaneState[] = LANE_STATUS_TRANSITIONS[from];
  invariant(
    from === to || legal.includes(to),
    'LANE_STATE_INVALID',
    `A ${from} Lane cannot become ${to}. ${
      legal.length
        ? `It can become: ${legal.join(', ')}.`
        : 'It has no state to change to until it is ready (start finishes creating it).'
    }`,
  );
}
