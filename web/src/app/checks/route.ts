// SPDX-License-Identifier: Apache-2.0
// Settings > Landing and checks.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'checks', load: () => import('./LandingChecks') },
] satisfies ScreenRoutes;
