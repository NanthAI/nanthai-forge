// SPDX-License-Identifier: Apache-2.0
// Settings > People and access (the Settings place itself).
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: '', load: () => import('./PeopleAccess') },
] satisfies ScreenRoutes;
