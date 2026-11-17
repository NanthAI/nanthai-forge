// SPDX-License-Identifier: Apache-2.0
// Rebuilt screens (stage C), one lazy chunk per screen, so each loads with its route and never on first paint. Each
// screen folder registers its own addresses in `<folder>/route.ts` (screen-route.ts); this file only collects them.
// A place with no entry keeps its placeholder (Place.tsx).
import { lazy, Suspense, type LazyExoticComponent } from 'react';
import type { AccountPlace } from './paths';
import { Head, Placeholder } from './Place';
import { accountPlaceLabels } from './places';
import {
  accountScreenFor,
  projectScreenFor,
  type AccountProps,
  type PlaceProps,
  type ScreenEntry,
  type ScreenRoutes,
} from './screen-route';

export type { PlaceProps } from './screen-route';

const entries = Object.values(
  import.meta.glob<ScreenRoutes>('./*/route.ts', { eager: true, import: 'default' }),
).flat();
// One lazy component per entry, made on first use, so a screen keeps its identity (and state) across renders.
const made = new Map<ScreenEntry, unknown>();
function screenOf<E extends ScreenEntry>(entry: E) {
  if (!made.has(entry)) made.set(entry, lazy(entry.load as Parameters<typeof lazy>[0]));
  return made.get(entry) as LazyExoticComponent<Awaited<ReturnType<E['load']>>['default']>;
}

/** The place's rebuilt screen once the project is known; the placeholder otherwise. */
export function PlaceScreen(
  props: Omit<PlaceProps, 'projectId'> & { projectId: PlaceProps['projectId'] | null },
) {
  const entry = projectScreenFor(entries, props.route);
  const fallback = <Placeholder route={props.route} projectName={props.projectName} />;
  if (!entry || !props.projectId) return fallback;
  const Screen = screenOf(entry);
  return (
    <Suspense fallback={fallback}>
      <Screen {...props} projectId={props.projectId} />
    </Suspense>
  );
}

/** An account page's rebuilt screen; the placeholder until one is registered. */
export function AccountScreen({ place, ...props }: AccountProps & { place: AccountPlace }) {
  const entry = accountScreenFor(entries, place);
  if (!entry) return <Placeholder route={{ frame: 'account', place }} projectName="" />;
  const Screen = screenOf(entry);
  return (
    <Suspense fallback={<Head trail={[{ label: accountPlaceLabels[place] }]} sentence="Loading…" />}>
      <Screen {...props} />
    </Suspense>
  );
}
