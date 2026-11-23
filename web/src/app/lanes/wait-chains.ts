// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who waits on whom as chains (Item 8f94e5c3): each Lane waits on at most one thing, so the waits form paths. A chain
// starts at a Lane nobody waits behind, follows each arrow to the Lane, person or main it waits on, and ends there.
// A Lane already drawn in a longer chain is not drawn twice: the chain that reaches it ends on it, marked as joined.
// A path that comes back to a Lane on itself is a loop and is marked. A long path keeps its two ends and says how many
// Lanes it skips, so 50 open Lanes read as one short picture. Built from `waits()` only: no new read.
import type { Wait } from './model';

export const MAX_STEPS = 6;
export const MAX_CHAINS = 8;

/** One place on a chain: a Lane, what it ends on, or the Lanes skipped between. `via` is the wait that points here from
 * the step before (its time and reason); the first step has none. */
export type Step =
  | { kind: 'lane'; laneId: string; via: Wait | null; joined?: boolean }
  | { kind: 'end'; label: string; person: boolean; via: Wait | null }
  | { kind: 'skip'; lanes: number };

export type Chain = {
  steps: Step[];
  /** The path comes back to a Lane it already passed: these Lanes wait on each other. */
  loop: boolean;
  /** The first wait on the chain (the Lane at its tail), for the reason line under it. */
  tail: Wait;
  /** The oldest wait on it, the chain's rank. */
  since: string | null;
};

const earlier = (a: string | null, b: string | null) => ((b ?? '~') < (a ?? '~') ? b : a);

/** Compress a long path: its first two steps, a skip, its last three. A loop keeps the Lane it returns to and
 * everything after it, so the point where it closes is always drawn. */
function shorten(steps: Step[], loop: boolean): Step[] {
  if (steps.length <= MAX_STEPS) return steps;
  const last = steps.at(-1);
  const back =
    loop && last?.kind === 'lane'
      ? steps.findIndex(step => step.kind === 'lane' && step.laneId === last.laneId)
      : -1;
  const keepFrom = back > 0 ? back : steps.length - 3;
  const head = back > 0 ? 1 : 2;
  const hidden = steps.slice(head, keepFrom);
  if (!hidden.length) return steps;
  return [
    ...steps.slice(0, head),
    { kind: 'skip', lanes: hidden.filter(step => step.kind === 'lane').length },
    ...steps.slice(keepFrom),
  ];
}

export function waitChains(waits: readonly Wait[]): { chains: Chain[]; more: number } {
  const byLane = new Map(waits.map(wait => [wait.laneId, wait]));
  const behind = new Set(waits.flatMap(wait => (wait.onLane ? [wait.onLane] : [])));
  const drawn = new Set<string>();
  const chains: Chain[] = [];
  const walk = (start: Wait) => {
    const steps: Step[] = [{ kind: 'lane', laneId: start.laneId, via: null }];
    const path = new Set([start.laneId]);
    drawn.add(start.laneId);
    let loop = false;
    let since = start.since;
    for (let wait: Wait | undefined = start; wait;) {
      since = earlier(since, wait.since);
      if (!wait.onLane) {
        steps.push({ kind: 'end', label: wait.on, person: wait.person, via: wait });
        break;
      }
      if (path.has(wait.onLane)) {
        loop = true;
        steps.push({ kind: 'lane', laneId: wait.onLane, via: wait, joined: true });
        break;
      }
      const seen = drawn.has(wait.onLane);
      steps.push({ kind: 'lane', laneId: wait.onLane, via: wait, ...(seen ? { joined: true } : {}) });
      if (seen) break;
      path.add(wait.onLane);
      drawn.add(wait.onLane);
      wait = byLane.get(wait.onLane);
    }
    chains.push({ steps: shorten(steps, loop), loop, tail: start, since });
  };
  // Longest chains first so a shared stretch is drawn once, in the chain that gives it most context.
  const lengthFrom = (start: Wait) => {
    const path = new Set<string>();
    for (
      let wait: Wait | undefined = start;
      wait && !path.has(wait.laneId);
      wait = wait.onLane ? byLane.get(wait.onLane) : undefined
    )
      path.add(wait.laneId);
    return path.size;
  };
  const tails = waits.filter(wait => !behind.has(wait.laneId)).sort((a, b) => lengthFrom(b) - lengthFrom(a));
  tails.forEach(walk);
  // Whatever is left has Lanes waiting behind it all the way round: a loop with nothing behind it.
  waits.filter(wait => !drawn.has(wait.laneId)).forEach(wait => !drawn.has(wait.laneId) && walk(wait));
  // Longest wait first, but a loop is never left out by the cap: the Lanes that block each other are the point.
  chains.sort((a, b) => (a.since ?? '~').localeCompare(b.since ?? '~'));
  const kept = chains.filter(
    (chain, at) => chain.loop || at - chains.slice(0, at).filter(c => c.loop).length < MAX_CHAINS,
  );
  return { chains: kept, more: chains.length - kept.length };
}

/** "4 min", "3 h", "2 d": how long a wait has lasted. */
export const age = (from: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : minutes < 2880
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} d`;
};
