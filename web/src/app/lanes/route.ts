// SPDX-License-Identifier: Apache-2.0
// The Lanes place: overview, To read and Touching (Sessions and one Lane register in their own folders).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'lanes', load: () => import('./LanesPlace') }] satisfies ScreenRoutes;
