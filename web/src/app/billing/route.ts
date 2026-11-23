// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Billing (the screens live in web/src/billing).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'billing', load: () => import('../../billing/Home') }] satisfies ScreenRoutes;
