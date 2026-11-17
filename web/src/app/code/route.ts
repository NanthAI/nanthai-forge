// SPDX-License-Identifier: Apache-2.0
// Code: what landed, one receipt, and files at main or any landing.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'code', load: () => import('./CodePlace') }] satisfies ScreenRoutes;
