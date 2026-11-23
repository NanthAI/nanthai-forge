// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Project (Item 966cb821): the project's name, address, owner and lifecycle.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'project', load: () => import('./ProjectSettings') },
] satisfies ScreenRoutes;
