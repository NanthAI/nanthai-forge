// SPDX-License-Identifier: Apache-2.0
// Settings > Project (Item 966cb821): the project's name, address, owner and lifecycle.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'project', load: () => import('./ProjectSettings') },
] satisfies ScreenRoutes;
