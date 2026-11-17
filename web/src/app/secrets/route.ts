// SPDX-License-Identifier: Apache-2.0
// Settings > Secrets.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'secrets', load: () => import('./Secrets') },
] satisfies ScreenRoutes;
