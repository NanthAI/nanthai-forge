// SPDX-License-Identifier: Apache-2.0
// What each place shows until its rebuilt screen lands (stage C): the breadcrumb, the place's head and one link to the
// screen that serves it today, so every supported destination stays reachable through the new frames.
import { lazy, Suspense, type ReactNode } from 'react';
const You = lazy(() => import('./You'));
const InvitationHome = lazy(() => import('./people/InvitationHome'));
import { A } from './frames';
import { currentScreenHref, hrefFor, type AppRoute } from './paths';
import {
  accountPlaceLabels,
  accountSentence,
  placeSentence,
  projectPlaceLabels,
  sectionLabels,
} from './places';

type Crumb = { label: string; href?: string };

/** The trail from the project (or account) to this page; the last crumb is the page itself. */
export function crumbsFor(route: AppRoute, projectName: string): Crumb[] {
  if (route.frame === 'account')
    return [
      { label: 'Account', href: hrefFor({ frame: 'account', place: 'projects' }) },
      { label: accountPlaceLabels[route.place] },
    ];
  if (route.frame !== 'project') return [];
  const at = (patch: Partial<typeof route>) => hrefFor({ ...route, ...patch });
  const trail: Crumb[] = [
    { label: projectName, href: at({ place: 'needs', section: '', rest: '' }) },
    { label: projectPlaceLabels[route.place], href: at({ section: '', rest: '' }) },
  ];
  if (route.section)
    trail.push({ label: sectionLabels[route.place][route.section] ?? route.section, href: at({ rest: '' }) });
  if (route.rest)
    trail.push({
      label:
        route.place === 'code' && route.section === 'files'
          ? route.rest.split('/').at(-1)!
          : route.rest.slice(0, 8),
    });
  const last = trail.at(-1)!;
  delete last.href;
  return trail;
}

/** The page head (DESIGN.md frames): the trail as the h1, the place's sentence, then its tools. */
export function Head({
  trail,
  sentence,
  children,
}: {
  trail: Crumb[];
  sentence: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="head">
      <h1 className="crumb">
        {trail.map((crumb, index) => (
          <span key={index} className="crumb-step">
            {index ? (
              <span className="t3" aria-hidden="true">
                /
              </span>
            ) : null}
            {crumb.href ? (
              <A href={crumb.href} className="cut" translate="no">
                {crumb.label}
              </A>
            ) : (
              <span className="cut" aria-current="page" translate="no">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </h1>
      <p className="sit">{sentence}</p>
      {children ? <div className="tools">{children}</div> : null}
    </div>
  );
}

/** The placeholder body of a place: its head and the way to the screen that serves it now. */
export function Placeholder({ route, projectName }: { route: AppRoute; projectName: string }) {
  if (route.frame === 'account' && route.place === 'projects')
    return (
      <Suspense fallback={<Head trail={[{ label: 'Home' }]} sentence="Loading…" />}>
        <InvitationHome />
      </Suspense>
    );
  if (route.frame === 'project' && route.place === 'settings' && route.section === 'you')
    return (
      <Suspense
        fallback={
          <p className="quietline" aria-busy="true">
            Loading…
          </p>
        }
      >
        <You />
      </Suspense>
    );
  const current = currentScreenHref(route);
  const title =
    route.frame === 'project'
      ? (sectionLabels[route.place][route.section] ?? projectPlaceLabels[route.place])
      : route.frame === 'account'
        ? accountPlaceLabels[route.place]
        : '';
  const sentence =
    route.frame === 'project'
      ? placeSentence[route.place]
      : route.frame === 'account'
        ? accountSentence[route.place]
        : '';
  return (
    <Head trail={crumbsFor(route, projectName)} sentence={sentence}>
      {current ? (
        <a className="btn sm" href={current}>
          Open the current {title} screen
        </a>
      ) : null}
    </Head>
  );
}
