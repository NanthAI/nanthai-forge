// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';

/** Prepare activity source facts from one immutable Work revision. A metadata
 * publication race can reuse path differences for unchanged source pins. */
export function activitySnapshot(
  store: WorkStore,
  ids: Set<string>,
  signal: string | undefined,
  pathsByHead: Map<string, string[]>,
  viewId?: string,
  acceptanceId?: string,
) {
  return store.observing(() => ({
    pointer: store.pointer(),
    revision: store.revision(),
    view: viewId ? store.select('views', viewId) : undefined,
    move: acceptanceId ? store.select('channelMoves', acceptanceId) : undefined,
    rows: [...ids].flatMap(id => {
      const lane = store.select('lanes', id);
      if (!lane) return [];
      const intent = store.select('intents', lane.intentId)!;
      let paths: string[] = [];
      if (!signal && store.native && lane.head !== lane.base) {
        const key = `${lane.base}:${lane.head}`;
        const cached = pathsByHead.get(key);
        if (cached) paths = cached;
        else {
          const source = new NativeSource(store.root),
            before = new Map(source.state(lane.base).files.map(file => [file.path, file])),
            after = new Map(source.state(lane.head).files.map(file => [file.path, file]));
          paths = [...new Set([...before.keys(), ...after.keys()])].filter(
            path => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)),
          );
          pathsByHead.set(key, paths);
        }
      }
      return [{ lane, intent, paths }];
    }),
  }));
}
