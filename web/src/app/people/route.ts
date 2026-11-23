// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > People and access (the Settings place itself); Account > People and teams (Item a841a76d).
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: '', load: () => import('./PeopleAccess') },
  { place: 'people', load: () => import('./AccountPeople') },
] satisfies ScreenRoutes;
