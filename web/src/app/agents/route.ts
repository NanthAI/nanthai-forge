// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Agents (Item f2ee8381): how the owner, and each person, wants agents to work.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'agents', load: () => import('./AgentGuidance') },
] satisfies ScreenRoutes;
