// SPDX-License-Identifier: Apache-2.0
import { savedStack } from './landing-compose-source.js';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { WorkView } from './work-types.js';
/** Attribute only accepted deltas that touch the paths of the actual conflict. */
export function landingConflictPeers(
  store: WorkStore,
  main: string,
  inputs: WorkView['inputs'],
  paths: string[],
) {
  if (!store.native || !paths.length) return [];
  const data = store.load(),
    source = new NativeSource(store.root),
    ancestry = source.ancestry();
  const mine = new Set(inputs.map(pin => pin.laneId)),
    peers = new Set<string>();
  const touches = (before: string, after: string) => {
    const a = new Map(source.state(before).files.map(file => [file.path, `${file.mode}:${file.blob}`]));
    const b = new Map(source.state(after).files.map(file => [file.path, `${file.mode}:${file.blob}`]));
    return [...new Set([...a.keys(), ...b.keys()])].some(
      path =>
        a.get(path) !== b.get(path) &&
        paths.some(
          conflict => path === conflict || path.startsWith(conflict + '/') || conflict.startsWith(path + '/'),
        ),
    );
  };
  for (const move of data.channelMoves) {
    if (move.status !== 'accepted' || !ancestry.contains(main, move.head)) continue;
    const previous = move.previous ?? data.nativeHead;
    if (!previous || !touches(previous, move.head)) continue;
    for (const pin of data.views.find(view => view.id === move.viewId)?.inputs ?? []) {
      if (mine.has(pin.laneId) || inputs.some(input => ancestry.contains(input.head, pin.head))) continue;
      const lane = data.lanes.find(lane => lane.id === pin.laneId);
      if (!lane) continue;
      const synced = [...lane.checkpoints]
        .reverse()
        .find(checkpoint => checkpoint.sync && ancestry.contains(pin.head, checkpoint.head));
      const base = savedStack(lane, pin.head)?.head ?? synced?.sync?.target ?? lane.base;
      if (touches(base, pin.head)) peers.add(pin.laneId);
    }
  }
  return [...peers];
}
