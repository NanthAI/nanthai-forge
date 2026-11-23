// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What a screen folder's `route.ts` registers (Run C2): the places and account pages that folder's lazy screen serves.
// screens.tsx collects every `web/src/app/<folder>/route.ts`, so a new screen adds files and edits no shared one.
// A route file is data: addresses and `load: () => import(...)`, with no value imports (tests/app-screen-routes), so
// it never pulls its screen into the first paint.
import type { ComponentType } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { LineFeed } from './Line';
import type { NeedsRead } from './needs/count';
import type { AccountPlace, AppRoute, ProjectPlace } from './paths';

export type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;

/** What every rebuilt place screen gets from the project frame: the address, the project and the line it already reads. */
export type PlaceProps = {
  route: ProjectRoute;
  projectId: Id<'hostedProjects'>;
  projectName: string;
  feed: LineFeed | undefined;
  feedError?: boolean;
  feedReadAt?: number;
  viewerHandle: string | undefined;
  /** The shell's Needs me read (App.tsx), shared so a place never subscribes to it again. */
  needsRead?: NeedsRead | undefined;
};

/** What an account page gets from the account frame. */
export type AccountProps = { handle: string | undefined; leave: () => void };

type Load<P> = () => Promise<{ default: ComponentType<P> }>;

/**
 * One project screen. The most specific entry wins: one whose `match` accepts the address, then one for the exact
 * `section` ('' is the place itself), then the place's catch-all (no section, no match). Matches must not overlap.
 */
export type ProjectScreen = {
  place: ProjectPlace;
  section?: string;
  match?: (route: ProjectRoute) => boolean;
  load: Load<PlaceProps>;
};
/** One account page. Account and project place names never coincide (paths.ts), so the place names the frame. */
export type AccountScreen = { place: AccountPlace; load: Load<AccountProps> };
export type ScreenEntry = ProjectScreen | AccountScreen;
/** A route file's default export. */
export type ScreenRoutes = readonly ScreenEntry[];

/** The project screen entry for an address, or undefined (the place keeps its placeholder). */
export function projectScreenFor(entries: readonly ScreenEntry[], route: ProjectRoute) {
  const here = entries.filter((entry): entry is ProjectScreen => entry.place === route.place);
  return (
    here.find(
      entry =>
        entry.match && (entry.section === undefined || entry.section === route.section) && entry.match(route),
    ) ??
    here.find(entry => !entry.match && entry.section === route.section) ??
    here.find(entry => !entry.match && entry.section === undefined)
  );
}

export function accountScreenFor(entries: readonly ScreenEntry[], place: AccountPlace) {
  return entries.find((entry): entry is AccountScreen => entry.place === place);
}
