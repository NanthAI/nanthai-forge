// SPDX-License-Identifier: Apache-2.0
import { join, resolve, sep } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { unacknowledgedOverlaps } from './agent-edit-notices.js';

const callers = new Map<string, string>();
export function rememberCaller(root: string, laneId: string | undefined) {
  if (laneId && /^[a-f0-9-]{36}$/.test(laneId)) callers.set(root, laneId);
}

/** Source output stays byte-exact; JSON surfaces reuse this local-only envelope. */
export function callerOverlaps(root: string, selectedLane?: string) {
  let owner = resolve(root),
    laneId = selectedLane ?? process.env.FORGE_LANE_ID;
  try {
    const marker = JSON.parse(readFileSync(join(owner, '.forge', 'native.json'), 'utf8'));
    owner = realpathSync(resolve(owner, marker.owner));
  } catch {
    /* Non-native surfaces have no local first-write inbox. */
  }
  laneId ??= callers.get(owner);
  const prefix = join(owner, '.forge', 'work') + sep + 'lane-';
  if (!laneId && process.cwd().startsWith(prefix)) laneId = process.cwd().slice(prefix.length).split(sep)[0];
  if (!laneId || !/^[a-f0-9-]{36}$/.test(laneId) || !existsSync(join(owner, '.forge', 'work', 'work.json')))
    return undefined;
  try {
    return unacknowledgedOverlaps(join(owner, '.forge', 'work'), laneId);
  } catch {
    return { count: null, items: [], coverage: 'unavailable' };
  }
}
export function withCallerOverlaps(root: string, response: unknown, laneId?: string) {
  const overlaps = callerOverlaps(root, laneId);
  return overlaps && response && typeof response === 'object' && !Array.isArray(response)
    ? { ...response, unacknowledgedOverlaps: overlaps }
    : response;
}
