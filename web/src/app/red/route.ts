// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One main red's address (Item ae068e0c): /<handle>/<project>/code/red/<sequence>, the audit event's sequence. Kept
// apart from the screen so the shell can match it without loading the screen's chunk.
import type { ProjectRoute, ScreenRoutes } from '../screen-route';

const RED = /^red\/(\d{1,15})$/;

/** The red event's sequence this address shows, or null. */
export function redSequenceOf(route: ProjectRoute): number | null {
  const match = route.place === 'code' && !route.section ? RED.exec(route.rest) : null;
  return match ? Number(match[1]) : null;
}

export default [
  {
    place: 'code',
    match: route => redSequenceOf(route) !== null,
    load: () => import('./MainRed'),
  },
] satisfies ScreenRoutes;
