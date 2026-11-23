// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Projects: the projects list (Item 3d5d8839), and a bulk delete request in it (Item 7456856f) at
// /account?request=ID.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'projects', load: () => import('./AccountProjects') }] satisfies ScreenRoutes;
