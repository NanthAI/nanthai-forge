// SPDX-License-Identifier: Apache-2.0
// Account > Your data (Item 17cdc774).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'data', load: () => import('./YourData') }] satisfies ScreenRoutes;
