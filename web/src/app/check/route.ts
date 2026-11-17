// SPDX-License-Identifier: Apache-2.0
// The landing check's address (Item b030c3c5): /-/<handle>/<project>/lanes/<laneId>/check. Kept apart from the screen so
// the shell can match it without loading the screen's chunk.
import type { AppRoute } from '../paths';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
const CHECK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/check$/i;

/** The Lane whose landing check this address shows, or null. */
export function checkLaneOf(route: ProjectRoute): string | null {
  return route.place === 'lanes' && !route.section ? (CHECK.exec(route.rest)?.[1] ?? null) : null;
}
