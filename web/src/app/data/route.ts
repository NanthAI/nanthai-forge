// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Your data (Item 17cdc774).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'data', load: () => import('./YourData') }] satisfies ScreenRoutes;
