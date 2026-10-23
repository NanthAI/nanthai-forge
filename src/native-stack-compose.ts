// SPDX-License-Identifier: Apache-2.0
import { overlappingPaths, type NativeSource } from './native-source.js';
/** Sync and landing apply only the child's delta from its saved parent tree. */
export function composeStack(
  source: NativeSource,
  child: string,
  target: string,
  base: string,
  message: string,
  at: string,
) {
  const merged = source.mergeFiles(child, target, new Set([base]), new Set([base]), undefined, {
    insertionOrder: 'right-first',
  });
  const conflicts = [...merged.conflicts.map(item => item.path), ...overlappingPaths(merged.files)];
  return {
    conflicts,
    ...(!conflicts.length
      ? { head: source.writeState(merged.files, [...new Set([target, child])], message, at) }
      : {}),
  };
}
