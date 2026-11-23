// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
