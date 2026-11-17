// SPDX-License-Identifier: Apache-2.0
// Account > Projects: a bulk delete request in it (Item 7456856f) at /-/account?request=ID; the rest of the place keeps
// its placeholder.
import type { ScreenRoutes } from '../screen-route';

export default [{ place: 'projects', load: () => import('./AccountProjects') }] satisfies ScreenRoutes;
