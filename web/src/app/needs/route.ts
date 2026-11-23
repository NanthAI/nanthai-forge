// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me, the project's front page.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'needs', load: () => import('./NeedsMe') }] satisfies ScreenRoutes;
