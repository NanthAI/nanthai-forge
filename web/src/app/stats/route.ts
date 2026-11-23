// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats: measured landing figures and the own-history comparison.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'stats', load: () => import('./Stats') }] satisfies ScreenRoutes;
