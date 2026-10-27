import { stackParentFailed } from './stack-parent-outcome.js';
// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { allRecords } from './agent-lifecycle.js';
import { noopLandingViews } from './agent-landed-views.js';
import type { WorkStore } from './work-store.js';
import type { Lane, ChannelMove } from './work-types.js';

/** Status accepts stored Lanes and the public receipts used by project pages. */
export type StackLane = Pick<Lane, 'stack'> & ({ id: string } | { laneId: string });
const parentId = (stack: Lane['stack']) =>
  typeof stack?.laneId === 'string' && stack.laneId.length ? stack.laneId : undefined;
const currentChannelHead = (store: WorkStore, channel: string) =>
  allRecords<ChannelMove>(store, 'channelMoves')
    .filter(move => move.channel === channel && move.status === 'accepted')
    .at(-1)?.head ?? null;

/** A landing is established by a Candidate input and a receipt still on main,
 * never by coincidental source containment or the parent's lifecycle alone. */
export function stackLanding(store: WorkStore, lane: Pick<Lane, 'stack'>, mainTarget?: string) {
  const stack = lane.stack;
  if (!stack || stack.detached || !parentId(stack)) return undefined;
  const parent = store.select('lanes', stack.laneId);
  const moves = allRecords<ChannelMove>(store, 'channelMoves');
  // A no-op receipt also needs an accepted Channel head; before the first
  // acceptance there is no landing evidence to inspect.
  if (!moves.some(move => move.channel === stack.channel && move.status === 'accepted')) return undefined;
  const inputs = new Map<string, { laneId: string; head: string }[]>(
    moves.flatMap(move => {
      if (move.channel !== stack.channel || move.status !== 'accepted') return [];
      // A cumulative batch Candidate belongs to its last entry's Intent, but
      // its accepted inputs can include parent Lanes from other Intents.
      const view = store.select('views', move.viewId);
      const input = view?.inputs.find(pin => pin.laneId === stack.laneId);
      return input ? [[move.viewId, [input]]] : [];
    }),
  );
  for (const { view, main } of noopLandingViews(store, stack.channel)) {
    const input = view.inputs.find(pin => pin.laneId === stack.laneId);
    if (!input) continue;
    for (const move of moves) {
      if (move.channel !== stack.channel || move.status !== 'accepted' || move.head !== main) continue;
      inputs.set(move.viewId, [...(inputs.get(move.viewId) ?? []), input]);
    }
  }
  if (!inputs.size) return undefined;
  const main =
    mainTarget ??
    moves.filter(move => move.channel === stack.channel && move.status === 'accepted').at(-1)?.head;
  if (!main) return undefined;
  const ancestry = new NativeSource(store.root).ancestry();
  return moves.reverse().find(move => {
    if (move.channel !== stack.channel || move.status !== 'accepted') return false;
    const input = inputs.get(move.viewId);
    // Unrelated acceptances cannot establish a parent landing. In particular,
    // do not traverse every full source tree in main's history for a new stack.
    if (!input || !ancestry.contains(main, move.head)) return false;
    // A parent can have been restacked itself; its saved checkpoint history is
    // retained even when its new State no longer has the old head as an ancestor.
    return input.some(
      pin => pin.head === stack.head || pin.head === parent?.head || ancestry.contains(pin.head, stack.head),
    );
  });
}
export function stackStatus(store: WorkStore, lane: StackLane) {
  const stack = lane.stack;
  if (!stack) return undefined;
  const parent = parentId(stack) ? store.select('lanes', stack.laneId) : undefined;
  const landing = stackLanding(store, lane);
  const failed = !landing && stackParentFailed(store, lane);
  const status = stack.detached
    ? 'main'
    : !parentId(stack)
      ? 'parent-unknown'
      : landing
        ? 'parent-landed'
        : failed
          ? 'parent-failed'
          : !parent
            ? 'parent-missing'
            : parent.state === 'abandoned'
              ? 'parent-abandoned'
              : parent.head !== stack.head
                ? 'parent-moved'
                : 'up-to-date';
  const chain = ['id' in lane ? lane.id : lane.laneId];
  const seen = new Set(chain);
  let cursor = lane.stack;
  let chainStatus: 'parent-unknown' | 'parent-missing' | 'cycle' | undefined;
  while (cursor && !cursor.detached) {
    const id = parentId(cursor);
    if (!id) {
      chainStatus = 'parent-unknown';
      break;
    }
    if (seen.has(id)) {
      chainStatus = 'cycle';
      break;
    }
    const ancestor = store.select('lanes', id);
    if (!ancestor) {
      chainStatus = 'parent-missing';
      break;
    }
    seen.add(id);
    chain.unshift(id);
    cursor = ancestor.stack;
  }
  return {
    status,
    parent: parentId(stack) ?? null,
    savedParent: stack.head,
    parentHead: parent?.head ?? null,
    target:
      landing?.head ??
      (stack.detached || failed
        ? (currentChannelHead(store, stack.channel) ?? store.load().nativeHead)
        : parent?.head) ??
      null,
    ...(landing ? { acceptanceId: landing.id } : {}),
    depth: chain.length,
    ...(chainStatus ? { chainStatus } : {}),
    summary: `${chain.map(id => id.slice(0, 8)).join(' → ')} · ${status}${chainStatus && chainStatus !== status ? ` · ${chainStatus}` : ''}`,
    ...(['parent-abandoned', 'parent-failed'].includes(status)
      ? { next: 'sync with ontoMain:true reapplies only this Lane’s delta onto main.' }
      : {}),
  };
}
export function stackSyncTarget(store: WorkStore, lane: Lane, ontoMain = false, mainTarget?: string) {
  const stack = lane.stack;
  if (!stack || stack.detached) return undefined;
  const landing = stackLanding(store, lane);
  const detached = ontoMain || !!landing || stackParentFailed(store, lane);
  const target = detached
    ? (mainTarget ?? currentChannelHead(store, stack.channel) ?? store.load().nativeHead)
    : store.select('lanes', stack.laneId)?.head;
  return target
    ? {
        target,
        stack: {
          base: lane.base,
          before: stack,
          after: { ...stack, head: target, ...(detached ? { detached: true } : {}) },
        },
      }
    : undefined;
}
