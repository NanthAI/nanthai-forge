// SPDX-License-Identifier: Apache-2.0
// Lanes > Sessions, and who holds one Lane (/lanes/<laneId>/holder).
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'lanes', section: 'sessions', load: () => import('./Sessions') },
  {
    place: 'lanes',
    section: '',
    match: route => route.rest.endsWith('/holder'),
    load: () => import('./Holder'),
  },
] satisfies ScreenRoutes;
