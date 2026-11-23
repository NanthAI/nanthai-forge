// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Code: what landed, one receipt, and files at main or any landing.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'code', load: () => import('./CodePlace') }] satisfies ScreenRoutes;
