// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { allRecords } from './agent-lifecycle.js';
import type { WorkStore } from './work-store.js';
import type { Lane, ChannelMove, WorkView } from './work-types.js';
const currentChannelHead = (store: WorkStore, channel: string) =>
  allRecords<ChannelMove>(store, 'channelMoves')
    .filter(move => move.channel === channel && move.status === 'accepted')
    .at(-1)?.head ?? null;

/** A landing is established by a Candidate input and a receipt still on main,
 * never by coincidental source containment or the parent's lifecycle alone. */
export function stackLanding(store: WorkStore, lane: Lane) {
  const stack = lane.stack;
  if (!stack || stack.detached) return undefined;
  const parent = store.select('lanes', stack.laneId);
  const tx = store.readRecords();
  const views =
    tx && parent ? tx.all('views', parent.intentId, 'intentId') : allRecords<WorkView>(store, 'views');
  const inputs = new Map(
    views.flatMap(view => {
      const input = view.inputs.find(pin => pin.laneId === stack.laneId);
      return input ? [[view.id, input] as const] : [];
    }),
  );
  if (!inputs.size) return undefined;
  const moves = allRecords<ChannelMove>(store, 'channelMoves');
  const main = moves
    .filter(move => move.channel === stack.channel && move.status === 'accepted')
    .at(-1)?.head;
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
    return (
      input.head === stack.head || input.head === parent?.head || ancestry.contains(input.head, stack.head)
    );
  });
}
export function stackStatus(store: WorkStore, lane: Lane) {
  const stack = lane.stack;
  if (!stack) return undefined;
  const parent = store.select('lanes', stack.laneId);
  const landing = stackLanding(store, lane);
  const status = stack.detached
    ? 'main'
    : landing
      ? 'parent-landed'
      : parent?.state === 'abandoned'
        ? 'parent-abandoned'
        : parent?.head !== stack.head
          ? 'parent-moved'
          : 'up-to-date';
  const chain = [lane.id];
  const seen = new Set(chain);
  let cursor: Lane | undefined = lane;
  while (cursor?.stack && !cursor.stack.detached && !seen.has(cursor.stack.laneId)) {
    seen.add(cursor.stack.laneId);
    chain.unshift(cursor.stack.laneId);
    cursor = store.select('lanes', cursor.stack.laneId);
  }
  return {
    status,
    parent: stack.laneId,
    savedParent: stack.head,
    parentHead: parent?.head ?? null,
    target:
      landing?.head ??
      (stack.detached
        ? (currentChannelHead(store, stack.channel) ?? store.load().nativeHead)
        : parent?.head) ??
      null,
    ...(landing ? { acceptanceId: landing.id } : {}),
    depth: chain.length,
    summary: `${chain.map(id => id.slice(0, 8)).join(' → ')} · ${status}`,
    ...(status === 'parent-abandoned'
      ? { next: 'sync with ontoMain:true reapplies only this Lane’s delta onto main.' }
      : {}),
  };
}
export function stackSyncTarget(store: WorkStore, lane: Lane, ontoMain = false, mainTarget?: string) {
  const stack = lane.stack;
  if (!stack || stack.detached) return undefined;
  const landing = stackLanding(store, lane);
  const detached = ontoMain || !!landing;
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
