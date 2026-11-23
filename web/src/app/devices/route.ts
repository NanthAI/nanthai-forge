// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Sign-in and devices (web/src/app/You.tsx).
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'devices', load: () => import('../You') }] satisfies ScreenRoutes;
