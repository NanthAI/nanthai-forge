// SPDX-License-Identifier: Apache-2.0
// A landing's evidence: /<handle>/<project>/lanes/<laneId>/checked (docs/development.md "Rebuilt app under `/-`").
import type { ScreenRoutes } from '../screen-route';

export default [
  {
    place: 'lanes',
    match: route => route.rest.endsWith('/checked'),
    load: () => import('./ProofPage'),
  },
] satisfies ScreenRoutes;
