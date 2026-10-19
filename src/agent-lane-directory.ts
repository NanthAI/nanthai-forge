// SPDX-License-Identifier: Apache-2.0
import { lstatSync } from 'node:fs';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
/** Re-materialize a native Lane whose directory was removed (for example by `clean`) from its
 * retained head State. An existing directory is never touched. Safe to repeat. */
export function ensureLaneDirectory(
  store: WorkStore,
  laneId: string,
  onWarnings?: (warnings: string[]) => void,
): boolean {
  if (!store.native) return false;
  const path = store.path(laneId);
  if (present(path)) return false;
  return store.locked(() => {
    const lane = store.select('lanes', laneId, 'id', true);
    if (!lane || lane.state === 'creating' || present(path)) return false;
    const warnings = new NativeSource(store.root).materialize(lane.head, path);
    onWarnings?.(warnings);
    return true;
  });
}
