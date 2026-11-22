// SPDX-License-Identifier: Apache-2.0
// Settings > Agents (Item f2ee8381): how the owner, and each person, wants agents to work.
import type { ScreenRoutes } from '../screen-route';

export default [
  { place: 'settings', section: 'agents', load: () => import('./AgentGuidance') },
] satisfies ScreenRoutes;
