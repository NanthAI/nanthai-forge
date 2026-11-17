// SPDX-License-Identifier: Apache-2.0
// Settings > GitHub mirror.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'mirror', load: () => import('./Mirror') },
] satisfies ScreenRoutes;
