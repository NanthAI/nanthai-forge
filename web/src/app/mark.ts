// SPDX-License-Identifier: Apache-2.0
// What the top-bar F shows (Item 641d887b; DESIGN.md "Brand mark states"), worked out from the live line feed the
// project frame already reads: no other read, no listener but one visibilitychange, and at most one timer, armed only
// for the next moment the picture changes by itself. One-shots fire once per event, never on a re-render, a repeated
// delivery or the first read of a project. Paused and queued have no field in the feed, so they are never shown.
import { useEffect, useRef, useState } from 'react';
import { useReadsAsleep } from '../live-reads';
import type { StateWord } from '../ds';
import type { MarkState } from '../ui/brand';
import type { LineFeed } from './Line';

const FAILED_MS = 10_000;
const LANDED_MS = 3_000;
export const CALM_MS = 60_000;
export const STILL_MS = 300_000;
const looping = new Set<MarkState>(['idle', 'w1', 'wN', 'checks', 'overlap', 'waiting', 'queued']);
const words: Partial<Record<MarkState, StateWord>> = {
  failed: 'Check failed',
  landed: 'Landed',
  rolledback: 'Set aside',
  overlap: 'Conflict',
};

type Shot = { state: 'failed' | 'landed' | 'rolledback'; key: string; at: number; feed: LineFeed };
export type MarkMemory = { feed?: LineFeed; checking: Set<string>; exit?: string; shot?: Shot };
export const markMemory = (): MarkMemory => ({ checking: new Set() });

/** The strongest standing fact in the feed: landing > waiting > overlap > checks > working, many > working > idle. */
export function baseMark(feed: LineFeed | undefined): MarkState {
  if (!feed) return 'idle';
  const { lanes } = feed;
  if (lanes.some(lane => lane.stage === 'ready')) return 'landing';
  // Only a hold that waits on a person (approval or review); a Lane held on its own next step is agent work.
  if (lanes.some(lane => lane.held && !lane.fix)) return 'waiting';
  if (lanes.some(lane => lane.overlap)) return 'overlap';
  if (lanes.some(lane => lane.stage === 'checking')) return 'checks';
  const open = lanes.length + feed.more;
  return open === 0 ? 'idle' : open === 1 ? 'w1' : 'wN';
}

/** Take one delivery of the feed. A Lane that leaves Checking held did not take; a new exit landed or was set aside. */
export function observe(memory: MarkMemory, feed: LineFeed | undefined, now: number) {
  if (feed === memory.feed) return;
  const seen = memory.feed;
  memory.feed = feed;
  const exit = feed?.exit ? `${feed.exit.kind}:${feed.exit.laneId}:${feed.exit.at}` : undefined;
  let shot: Omit<Shot, 'at' | 'feed'> | undefined;
  if (seen && feed) {
    const failed = feed.lanes.find(
      lane =>
        memory.checking.has(lane.laneId) && lane.held && lane.stage !== 'checking' && lane.stage !== 'ready',
    );
    if (failed) shot = { state: 'failed', key: `failed:${failed.laneId}:${failed.changedAt}` };
    else if (exit && exit !== memory.exit)
      shot = { state: feed.exit!.kind === 'landed' ? 'landed' : 'rolledback', key: exit };
  }
  memory.checking = new Set(feed?.lanes.filter(lane => lane.stage === 'checking').map(lane => lane.laneId));
  memory.exit = exit;
  if (!feed) memory.shot = undefined;
  else if (shot && shot.key !== memory.shot?.key) memory.shot = { ...shot, at: now, feed };
}

/** The state to draw now, and when it would change by itself (a hold ending). Failed holds 10 s; landed and set
 * aside hold at least 3 s and then until the next delivery; landing outranks them, failed outranks landing. */
export function shownMark(memory: MarkMemory, now: number): { state: MarkState; until?: number } {
  const base = baseMark(memory.feed);
  const shot = memory.shot;
  if (shot?.state === 'failed' && now < shot.at + FAILED_MS)
    return { state: 'failed', until: shot.at + FAILED_MS };
  if (base === 'landing' || !shot || shot.state === 'failed') return { state: base };
  if (now < shot.at + LANDED_MS) return { state: shot.state, until: shot.at + LANDED_MS };
  return { state: memory.feed === shot.feed ? shot.state : base };
}

/** Calming down: a looping state doubles its periods after 60 s and holds its still after 5 min or once live reads
 * sleep; a state change, a return to the tab or the next input restarts the clock. */
export function markMotion(state: MarkState, quietMs: number, asleep: boolean): 'calm' | 'still' | undefined {
  if (!looping.has(state)) return undefined;
  return asleep || quietMs >= STILL_MS ? 'still' : quietMs >= CALM_MS ? 'calm' : undefined;
}

export function useMark(feed: LineFeed | undefined) {
  const memory = useRef<MarkMemory>(null);
  memory.current ??= markMemory();
  const [, redraw] = useState(0);
  const now = Date.now();
  observe(memory.current, feed, now);
  const { state, until } = shownMark(memory.current, now);
  const asleep = useReadsAsleep();
  const clock = useRef({ state, at: now, asleep });
  if (clock.current.state !== state || (clock.current.asleep && !asleep))
    clock.current = { state, at: now, asleep };
  clock.current.asleep = asleep;
  const motion = markMotion(state, now - clock.current.at, asleep);
  // The one timer: the next hold end, calm or still. None while hidden, still or settled.
  useEffect(() => {
    const next = Math.min(
      until ?? Infinity,
      motion === 'still' || !looping.has(state) ? Infinity : clock.current.at + (motion ? STILL_MS : CALM_MS),
    );
    if (next === Infinity || document.hidden) return;
    const timer = setTimeout(() => redraw(n => n + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  });
  // Hidden tab: every piece pauses (mark.css `.mk-hidden`); coming back counts as attention.
  useEffect(() => {
    const root = document.documentElement;
    const shown = () => {
      root.classList.toggle('mk-hidden', document.hidden);
      if (!document.hidden) clock.current.at = Date.now();
      redraw(n => n + 1);
    };
    root.classList.toggle('mk-hidden', document.hidden);
    document.addEventListener('visibilitychange', shown);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      root.classList.remove('mk-hidden');
    };
  }, []);
  return { state, motion, word: words[state] };
}
