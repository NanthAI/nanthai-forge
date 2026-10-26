// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { NativeSource } from './native-source.js';
import { nativeDependencyHead } from './native-pr-pins.js';
import { nativeChanges } from './native-diff.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import type { WorkData, WorkView, LocalWorkCommand } from './work-types.js';
import { executionBase } from './work-intent-local.js';
/** Source traversal/merge is speculative. Publication revalidates only the
 * selected source pins under the owner lock; unrelated Work writes survive. */
export function prepareNativeComposition(
  root: string,
  data: WorkData,
  command: Extract<LocalWorkCommand, { action: 'compose' }>,
) {
  const source = new NativeSource(root),
    at = new Date().toISOString(),
    objects = new Map<string, Buffer>();
  const intent = data.intents.find(item => item.id === command.intentId);
  invariant(intent, 'NOT_FOUND', 'Intent not found.');
  const dependencies = command.dependencies ?? intent.dependencies ?? [];
  invariant(
    command.inputs.length + dependencies.length > 0 &&
      new Set(command.inputs.map(item => item.laneId)).size === command.inputs.length,
    'BAD_ARGUMENT',
    'Select each Lane once or a pinned dependency.',
  );
  const nativeDependencies = dependencies.map(pin => ({ head: nativeDependencyHead(data, pin) }));
  const intentPins = JSON.stringify([intent.base, intent.dependencies]);
  for (const pin of command.inputs) {
    const item = data.lanes.find(lane => lane.id === pin.laneId);
    invariant(item, 'NOT_FOUND', 'Lane not found.');
    invariant(
      item.intentId === intent.id && item.head === pin.head,
      'LANE_STALE',
      'Selected native Lane changed or belongs to another Intent.',
    );
  }

  const view: WorkView = {
    id: randomUUID(),
    intentId: intent.id,
    base: executionBase(intent),
    inputs: command.inputs,
    dependencies,
    status: 'clean',
    at,
    details: '',
    ...(command.operationId
      ? { operation: { id: command.operationId, request: digest(JSON.stringify(command)) } }
      : {}),
  };
  let head = intent.base;
  for (const pin of [...nativeDependencies, ...command.inputs]) {
    const retained = new Set(
      [...source.state(head).files, ...source.state(pin.head).files].map(file => file.blob),
    );
    const merged = source.compose(head, pin.head, 'Native review composition', at);
    if (!merged.head) {
      view.status = 'conflict';
      view.details = `Conflicting native paths (both original States retained):\n${merged.conflicts.join('\n')}`;
      break;
    }
    head = merged.head;
    objects.set(head, source.object(head));
    for (const file of source.state(head).files)
      if (!retained.has(file.blob)) objects.set(file.blob, source.object(file.blob));
  }
  if (view.status === 'clean') {
    view.head = head;
    const main = composedNativeMain(source, data, head);
    if (main) view.composedMain = main;
    view.details = nativeChanges(source.state(intent.base).files, source.state(head).files);
  }
  return {
    view,
    dependencies,
    assertCurrent: (current: WorkData) => {
      const selected = current.intents.find(item => item.id === command.intentId);
      invariant(
        selected && JSON.stringify([selected.base, selected.dependencies]) === intentPins,
        'COMPOSITION_STALE',
        'Selected composition Intent source or dependencies changed; original work is retained.',
      );
      for (const pin of command.inputs) {
        const lane = current.lanes.find(item => item.id === pin.laneId);
        invariant(
          lane?.intentId === intent.id && lane.head === pin.head,
          'LANE_STALE',
          'Selected native Lane changed or belongs to another Intent.',
        );
      }
      dependencies.forEach((pin, index) =>
        invariant(
          nativeDependencyHead(current, pin) === nativeDependencies[index]!.head,
          'COMPOSITION_STALE',
          'Selected composition dependency changed; original work is retained.',
        ),
      );
    },
    restore: (target = source) => {
      for (const bytes of objects.values()) target.put(bytes);
    },
  };
}

/** Record the newest accepted main actually contained in this composition.
 * An unsynced input never silently selects newer accepted source. */
export function composedNativeMain(source: NativeSource, data: WorkData, head: string) {
  const accepted = data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted');
  if (accepted.length) return accepted.reverse().find(move => source.contains(head, move.head))?.head;
  // Before the first acceptance the owner's bootstrap State is main. Pin it just
  // like accepted main, so every runner gets the first candidate's actual diff.
  return data.nativeHead && source.contains(head, data.nativeHead) ? data.nativeHead : undefined;
}
