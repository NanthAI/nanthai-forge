// SPDX-License-Identifier: Apache-2.0
import { stackLanding } from './agent-stack.js';
import { composeStack } from './native-stack-compose.js';
import { resolveDocsComposition } from './native-docs-resolve.js';
import type { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkView } from './work-types.js';

/** Recover the stack pin of a queued saved head even after a later sync/undo. */
export function savedStack(lane: Lane, head: string) {
  let stack = lane.stack;
  for (const checkpoint of [...lane.checkpoints].reverse()) {
    if (checkpoint.head === head) return stack;
    if (checkpoint.undoSync) {
      const original = lane.checkpoints.find(item => item.operation?.id === checkpoint.undoSync);
      if (original?.sync?.stack) stack = original.sync.stack.after;
    } else if (checkpoint.sync?.stack) stack = checkpoint.sync.stack.before;
  }
  return stack;
}

/** Retarget an immutable View, retaining its exact input pins and the live Lane. */
export function composeLandingSource(
  store: WorkStore,
  source: NativeSource,
  view: WorkView,
  main: string,
  message: string,
  at: string,
) {
  const data = store.load();
  let base: string | undefined;
  for (const pin of view.inputs) {
    const lane = store.select('lanes', pin.laneId);
    if (!lane) continue;
    const stack = savedStack(lane, pin.head);
    if (!stack || stack.detached) continue;
    // A previous accepted child save is already a better common merge base.
    if (
      data.channelMoves.some(
        move =>
          move.status === 'accepted' &&
          data.views
            .find(candidate => candidate.id === move.viewId)
            ?.inputs.some(input => input.laneId === pin.laneId && source.contains(pin.head, input.head)) &&
          source.contains(main, move.head),
      )
    )
      continue;
    const landing = stackLanding(store, { ...lane, stack }, main);
    if (!landing || !source.contains(main, landing.head)) continue;
    // Already-retargeted Views must not replay the old parent's delta on retry.
    if (view.composedMain && source.contains(view.composedMain, landing.head)) continue;
    if (!base) base = stack.head;
    else {
      const merged = source.compose(base, stack.head, message, at);
      if (!merged.head) return merged;
      base = merged.head;
    }
  }
  if (base) return composeStack(source, view.head!, main, base, message, at);
  const composed = source.compose(main, view.head!, message, at);
  if (composed.head) return composed;
  const docs = resolveDocsComposition(source, view.head!, main, message, at);
  return docs ? { ...docs, conflicts: [] } : composed;
}
