// SPDX-License-Identifier: Apache-2.0
// Plan: the backlog, Initiatives and one Item.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'plan', load: () => import('./Plan') }] satisfies ScreenRoutes;
