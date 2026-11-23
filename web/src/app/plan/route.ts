// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Plan: the backlog, Initiatives and one Item.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'plan', load: () => import('./Plan') }] satisfies ScreenRoutes;
