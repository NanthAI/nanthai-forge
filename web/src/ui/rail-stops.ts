// SPDX-License-Identifier: Apache-2.0
import type { Tone } from './status';

/** One segment of the journey rail. `run` is the check stop while a check is queued or running. */
export type RailSegment = 'off' | 'on' | 'ok' | 'bad' | 'conf' | 'run';
export type RailStops = {
  segments: readonly [RailSegment, RailSegment, RailSegment, RailSegment];
  title: string;
};

/** What the rail needs to know about a Lane. `runStatus` is the check on the Lane's exact current head. */
export type RailInput = {
  tone: Tone;
  checkpoints: number;
  runStatus?: string;
  laterViewId?: string;
  open?: boolean;
  /** The Lane's work reached a Channel. Only then is the fourth stop filled. */
  accepted?: boolean;
};

const RUNNING = new Set(['preparing', 'running']);
const FAILED = new Set(['failed']);

/**
 * The four fixed stops (edited · saved · checked · accepted) for a Lane. A position, never a
 * percentage: the check stop fills only for a check on exactly this head, and the accepted stop
 * only once the work reached a Channel.
 */
export function railStops(lane: RailInput): RailStops {
  const saved = lane.checkpoints > 0;
  if (lane.accepted) return { segments: ['ok', 'ok', 'ok', 'ok'], title: 'edited, saved, checked, accepted' };
  if (lane.tone === 'conflict')
    return {
      segments: ['conf', 'conf', 'off', 'off'],
      title: 'edited, saved; blocked at check by a conflict',
    };
  if (lane.laterViewId)
    return { segments: ['on', 'on', 'off', 'off'], title: 'edited, saved; check superseded by a later View' };
  if (lane.runStatus && FAILED.has(lane.runStatus))
    return {
      segments: ['on', 'on', 'bad', 'off'],
      title:
        lane.runStatus === 'failed'
          ? 'edited, saved; check failed'
          : `edited, saved; check ${lane.runStatus}`,
    };
  if (lane.runStatus === 'cancelled' || lane.runStatus === 'interrupted')
    return { segments: ['on', 'on', 'off', 'off'], title: `edited, saved; check ${lane.runStatus}` };
  if (lane.runStatus === 'queued')
    return { segments: ['on', 'on', 'off', 'off'], title: 'edited, saved; check queued' };
  if (lane.runStatus && RUNNING.has(lane.runStatus))
    return { segments: ['on', 'on', 'run', 'off'], title: 'edited, saved; check running' };
  if (lane.runStatus === 'passed')
    return {
      segments: ['ok', 'ok', 'ok', 'off'],
      title:
        lane.open === false
          ? 'edited, saved, checked; not accepted'
          : 'edited, saved, checked; waiting for acceptance',
    };
  if (saved) return { segments: ['on', 'on', 'off', 'off'], title: 'edited, saved' };
  return { segments: ['on', 'off', 'off', 'off'], title: 'edited; nothing saved yet' };
}
