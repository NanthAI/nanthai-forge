// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > GitHub mirror.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'mirror', load: () => import('./Mirror') },
] satisfies ScreenRoutes;
