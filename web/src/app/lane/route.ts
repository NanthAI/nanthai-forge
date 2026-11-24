// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One Lane (/lanes/<laneId>): its own screen beside whatever serves the Lanes list.
import type { ScreenRoutes } from '../screen-route';

export default [
  {
    place: 'lanes',
    section: '',
    match: route => /^[^/]+(?:\/(?:thread|history))?$/.test(route.rest),
    load: () => import('./LaneReview'),
  },
] satisfies ScreenRoutes;
