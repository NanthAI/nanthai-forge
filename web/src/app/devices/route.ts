// SPDX-License-Identifier: Apache-2.0
// Account > Sign-in and devices (web/src/app/You.tsx).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'devices', load: () => import('../You') }] satisfies ScreenRoutes;
