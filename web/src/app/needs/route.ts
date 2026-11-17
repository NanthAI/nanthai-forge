// SPDX-License-Identifier: Apache-2.0
// Needs me, the project's front page.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'needs', load: () => import('./NeedsMe') }] satisfies ScreenRoutes;
