// SPDX-License-Identifier: Apache-2.0
// One Lane (/lanes/<laneId>): its own screen beside whatever serves the Lanes list.
import type { ScreenRoutes } from '../screen-route';

export default [
  {
    place: 'lanes',
    section: '',
    match: route => route.rest !== '' && !route.rest.includes('/'),
    load: () => import('./LaneReview'),
  },
] satisfies ScreenRoutes;
