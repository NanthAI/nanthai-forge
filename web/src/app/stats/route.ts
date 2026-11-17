// SPDX-License-Identifier: Apache-2.0
// Stats: measured landing figures and the own-history comparison.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'stats', load: () => import('./Stats') }] satisfies ScreenRoutes;
