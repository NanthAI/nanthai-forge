// SPDX-License-Identifier: Apache-2.0
// Account > Billing (the screens live in web/src/billing).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'billing', load: () => import('../../billing/Home') }] satisfies ScreenRoutes;
