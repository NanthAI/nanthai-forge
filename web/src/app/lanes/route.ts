// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Lanes place: overview, History and Touching (Sessions and one Lane register in their own folders).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'lanes', load: () => import('./LanesPlace') }] satisfies ScreenRoutes;
