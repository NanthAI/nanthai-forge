// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Landing and checks.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'checks', load: () => import('./LandingChecks') },
] satisfies ScreenRoutes;
