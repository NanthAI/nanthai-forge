// SPDX-License-Identifier: Apache-2.0
// Rebuilt place screens (stage C), one lazy chunk per place, so each screen loads with its route and never on first
// paint. A place with no entry here keeps its placeholder (Place.tsx). Each stage C Lane adds its own line. A place
// with sections may register one screen per section as 'place/section' (the first section is 'place/').
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { LineFeed } from './Line';
import type { AppRoute, ProjectPlace } from './paths';
import { Placeholder } from './Place';
import { checkLaneOf } from './check/route';

/** What every rebuilt place screen gets from the project frame: the address, the project and the line it already reads. */
export type PlaceProps = {
  route: Extract<AppRoute, { frame: 'project' }>;
  projectId: Id<'hostedProjects'>;
  projectName: string;
  feed: LineFeed | undefined;
  viewerHandle: string | undefined;
};

/** A Lane's landing check (/lanes/<laneId>/check) is its own screen, whichever screen the Lanes place has. */
const CheckScreen = lazy(() => import('./check/CheckScreen'));

const screens: Partial<
  Record<ProjectPlace | `${ProjectPlace}/${string}`, LazyExoticComponent<ComponentType<PlaceProps>>>
> = {
  needs: lazy(() => import('./needs/NeedsMe')),
  code: lazy(() => import('./code/CodePlace')),
  lanes: lazy(() => import('./lanes/LanesPlace')),
  'settings/': lazy(() => import('./people/PeopleAccess')),
  'settings/checks': lazy(() => import('./checks/LandingChecks')),
  plan: lazy(() => import('./plan/Plan')),
};

/** The place's rebuilt screen once the project is known; the placeholder otherwise. */
export function PlaceScreen(
  props: Omit<PlaceProps, 'projectId'> & { projectId: PlaceProps['projectId'] | null },
) {
  const checkLane = checkLaneOf(props.route);
  if (checkLane && props.projectId)
    return (
      <Suspense fallback={<Placeholder route={props.route} projectName={props.projectName} />}>
        <CheckScreen
          route={props.route}
          projectId={props.projectId}
          projectName={props.projectName}
          laneId={checkLane}
        />
      </Suspense>
    );
  const Screen = screens[`${props.route.place}/${props.route.section}`] ?? screens[props.route.place];
  if (!Screen || !props.projectId) return <Placeholder route={props.route} projectName={props.projectName} />;
  return (
    <Suspense fallback={<Placeholder route={props.route} projectName={props.projectName} />}>
      <Screen {...props} projectId={props.projectId} />
    </Suspense>
  );
}
