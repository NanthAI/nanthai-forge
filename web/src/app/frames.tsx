// SPDX-License-Identifier: Apache-2.0
// The four frames (DESIGN.md "Frames"): project (mark, project picker, line, Needs you, six places), account (the owner
// in the project's place, no line, the account's places), bare (no rail, no line; before a first project) and the
// public bar and column. Every control at first paint is a plain link or button; menus and sheets attach with the
// behaviour layer (decisions.md, shared-base rule 3). Each frame has a skip link, one main landmark and the phone tabs.
import type { FocusEvent, ReactNode } from 'react';
import { Avatar, Count, DockPerson, Menu, State, initials, type MenuAction } from '../ds';
import { Rail } from '../ds/Rail';
import { RailControls, useRailState } from '../ds/rail-state';
import { ForgeMark } from '../shell/brand';
import { Line, type LineFeed } from './Line';
import { useMark } from './mark';
import { accountPlaces, hrefFor, projectPlaces, type AccountPlace, type ProjectPlace } from './paths';
import { PlaceIcon, accountPlaceLabels, accountTabLabels, projectPlaceLabels } from './places';
import {
  PageLinks,
  ProjectMore,
  ProjectPagesProvider,
  placeHref,
  useProjectPages,
  type ProjectRoute,
} from './project-pages';
import { followLink, navigate } from './router';

export function A({
  href,
  children,
  ...rest
}: { href: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <a href={href} onClick={followLink} {...rest}>
      {children}
    </a>
  );
}

function Skip() {
  return (
    <a className="skip" href="#main">
      Skip to the page
    </a>
  );
}

/** The browser's focus scroll can leave an already onscreen control behind the sticky bars. */
function showPageFocus(event: FocusEvent<HTMLElement>) {
  const { target, currentTarget } = event;
  if (
    !(target instanceof HTMLElement) ||
    !currentTarget.contains(target) ||
    !target.matches(':focus-visible')
  )
    return;
  // Run after the browser and any composite widget have scrolled the newly focused control.
  requestAnimationFrame(() => {
    if (document.activeElement !== target) return;
    const { scrollPaddingBlockStart, scrollPaddingBlockEnd } = getComputedStyle(document.documentElement);
    let start = parseFloat(scrollPaddingBlockStart) || 0;
    const bulk = currentTarget.querySelector('.bulk');
    if (bulk && !bulk.contains(target) && getComputedStyle(bulk).position === 'sticky') {
      const bar = bulk.getBoundingClientRect();
      if (bar.top <= start && bar.bottom > start) start = bar.bottom;
    }
    const end = innerHeight - (parseFloat(scrollPaddingBlockEnd) || 0);
    const { top, bottom, height } = target.getBoundingClientRect();
    if (height > end - start && top < end && bottom > start) return;
    const shift = top < start ? top - start : Math.max(0, bottom - end);
    if (shift) window.scrollBy({ top: shift, behavior: 'instant' });
  });
}

/** The F follows the project (mark.ts). Its word takes the name's place while the state needs one, and is announced. */
function Brand({ href, feed }: { href: string; feed?: LineFeed }) {
  const { state, motion, word } = useMark(feed);
  return (
    <>
      <A className="brand" href={href} translate="no" aria-label="Forge">
        <ForgeMark state={state} motion={motion} size={20} />
        {word ? <State word={word} /> : <span>Forge</span>}
      </A>
      <span className="sr" role="status">
        {word}
      </span>
    </>
  );
}

/** The end of the top bar: go to or run, every key, and the account. */
function End({
  handle,
  onPalette,
  onKeys,
  children,
}: {
  handle: string | undefined;
  onPalette: () => void;
  onKeys: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="end">
      {children}
      <button
        type="button"
        className="ico"
        aria-label="Go to or run"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={onPalette}
      >
        <PlaceIcon name="find" />
      </button>
      <button
        type="button"
        className="ico hide-ph"
        aria-label="All keys"
        aria-keyshortcuts="?"
        onClick={onKeys}
      >
        <kbd aria-hidden="true">?</kbd>
      </button>
      <A
        className="ico"
        href={hrefFor({ frame: 'account', place: 'projects' })}
        aria-label={handle ? `${initials(handle)}, @${handle}, your account` : 'Your account'}
      >
        {handle ? <Avatar handle={`@${handle}`} /> : <span className="av none" aria-hidden="true" />}
      </A>
    </div>
  );
}

export type FrameControls = { onPalette: () => void; onKeys: () => void; viewerHandle: string | undefined };

function PhoneMore<Place extends string>({
  places,
  tabs,
  current,
  labels,
  href,
}: {
  places: readonly Place[];
  tabs: readonly Place[];
  current: Place;
  labels: Record<Place, string>;
  href: (place: Place) => string;
}) {
  const remaining = places.filter(place => !tabs.includes(place));
  const items = remaining.map(place => ({
    id: place,
    label: labels[place],
    onAction: () => navigate(href(place)),
  }));
  return (
    <Menu
      label="More"
      items={items}
      className="tabs-more"
      placement="top end"
      aria-current={remaining.includes(current) ? 'true' : undefined}
    >
      <PlaceIcon name="more" size={20} />
      More
    </Menu>
  );
}

type ProjectFrameProps = {
  route: ProjectRoute;
  projectId?: string | null;
  /** The project's display name once resolved; the address slug until then. */
  name: string;
  feed: LineFeed | undefined;
  /** What waits on the reader (needs/count.ts `needsCount`), the same number Needs me shows. */
  needs: { n: number; atLeast: boolean } | undefined;
  /** The project picker's entries; null until the picker is first opened. */
  projects: readonly { handle: string; slug: string; name: string }[] | null;
  controls: FrameControls & { onPicker: () => void };
  children: ReactNode;
};

export function ProjectFrame(props: ProjectFrameProps) {
  return (
    <ProjectPagesProvider
      route={props.route}
      projectId={props.projectId ?? null}
      viewer={props.controls.viewerHandle}
    >
      <ProjectShell {...props} />
    </ProjectPagesProvider>
  );
}

function ProjectShell({ route, name, feed, needs, projects, controls, children }: ProjectFrameProps) {
  const rail = useRailState();
  const { pages } = useProjectPages()!;
  const address = hrefFor(route) + (typeof location === 'undefined' ? '' : location.search);
  const held = needs?.n;
  const needsLabel =
    // The name starts with the words shown ("Needs you 3"), so speech and voice control match the screen.
    held === undefined ? 'Needs you' : `Needs you ${held}${needs?.atLeast ? ' or more' : ''}`;
  const pickerItems: MenuAction[] = [
    ...(projects ?? [])
      .filter(item => !(item.handle === route.handle && item.slug === route.project))
      .map(item => ({
        id: `${item.handle}/${item.slug}`,
        label: item.name,
        onAction: () =>
          navigate(hrefFor({ ...route, handle: item.handle, project: item.slug, section: '', rest: '' })),
      })),
    ...(projects?.length ? (['separator'] as const) : []),
    {
      id: 'all',
      label: 'All projects',
      onAction: () => navigate(hrefFor({ frame: 'account', place: 'projects' })),
    },
  ];
  const tabPlaces: readonly ProjectPlace[] = ['needs', 'lanes', 'plan', 'code'];
  return (
    <RailControls.Provider value={rail}>
      <div className="shell" data-frame="project" data-rail={rail.shut ? 'shut' : 'open'}>
        <Skip />
        <header className="top">
          <Brand href={placeHref(route, 'needs')} feed={feed} />
          <span
            onPointerEnter={controls.onPicker}
            onFocus={controls.onPicker}
            style={{ display: 'contents' }}
          >
            <Menu label={`Project: ${name}. Switch project`} items={pickerItems} className="proj">
              <span className="cut" translate="no">
                {name}
              </span>
            </Menu>
          </span>
          <Line feed={feed} handle={route.handle} project={route.project} />
          <End handle={controls.viewerHandle} onPalette={controls.onPalette} onKeys={controls.onKeys}>
            <A className="needs" href={placeHref(route, 'needs')} aria-label={needsLabel}>
              <span className="hide-ph">Needs you</span>
              {/* A space, so the shown text reads "Needs you 3" like its name (the flex row drops it). */}
              {held === undefined ? null : ' '}
              {held === undefined ? null : <Count n={held} hot={held > 0} />}
            </A>
          </End>
        </header>
        <Line feed={feed} handle={route.handle} project={route.project} phone />
        <Rail
          label="Project"
          address={address}
          {...rail}
          places={projectPlaces.map((place, index) => {
            const current = route.place === place;
            const nested = pages[place].length > 1;
            return {
              id: `sidebar-${place}`,
              label: projectPlaceLabels[place],
              href: placeHref(route, place),
              shortcut: String(index + 1),
              icon: <PlaceIcon name={place} />,
              badge: place === 'needs' && held ? <Count n={held} hot /> : null,
              current: current ? (nested ? 'true' : 'page') : undefined,
              marked: current && (rail.shut || !nested || !pages[place].some(page => page.current)),
              ...(current && nested ? { pages: <PageLinks pages={pages[place]} compact /> } : {}),
              ...(nested ? { flyPages: <PageLinks pages={pages[place]} compact fly /> } : {}),
            };
          })}
        />
        <main id="main" tabIndex={-1} onFocus={showPageFocus}>
          <DockPerson value={controls.viewerHandle ?? null}>{children}</DockPerson>
        </main>
        <nav className="tabs" aria-label="Project">
          {tabPlaces.map(place => (
            <A
              key={place}
              href={placeHref(route, place)}
              aria-current={route.place === place ? 'page' : undefined}
            >
              <PlaceIcon name={place} size={20} />
              {projectPlaceLabels[place]}
              {place === 'needs' && held ? <Count n={held} hot /> : null}
            </A>
          ))}
          <ProjectMore icon={<PlaceIcon name="more" size={20} />} />
        </nav>
      </div>
    </RailControls.Provider>
  );
}

export function AccountFrame({
  place,
  back,
  controls,
  children,
}: {
  place: AccountPlace;
  /** The project the person came from, offered as the way back. */
  back: { href: string; name: string } | null;
  controls: FrameControls;
  children: ReactNode;
}) {
  const tabPlaces: readonly AccountPlace[] = ['projects', 'billing', 'people'];
  const rail = useRailState();
  return (
    <RailControls.Provider value={rail}>
      <div className="shell" data-frame="account" data-rail={rail.shut ? 'shut' : 'open'}>
        <Skip />
        <header className="top">
          <Brand href={hrefFor({ frame: 'account', place: 'projects' })} />
          <span className="owner" translate="no">
            {controls.viewerHandle ? <Avatar handle={`@${controls.viewerHandle}`} /> : null}
            <span className="cut">
              {controls.viewerHandle ? `@${controls.viewerHandle}` : 'Your account'}
            </span>
          </span>
          <div className="fill" />
          <End handle={controls.viewerHandle} onPalette={controls.onPalette} onKeys={controls.onKeys} />
        </header>
        <Rail
          label="Account"
          heading="Account"
          address={place}
          {...rail}
          places={accountPlaces.map(name => ({
            id: `sidebar-${name}`,
            label: accountPlaceLabels[name],
            href: hrefFor({ frame: 'account', place: name }),
            current: place === name ? 'page' : undefined,
            marked: place === name,
            icon: <PlaceIcon name={name} />,
          }))}
          bottom={
            back ? (
              <A className="rail-link rail-back" href={back.href}>
                <PlaceIcon name="back" />
                <span className="rail-label cut" translate="no">
                  {back.name}
                </span>
              </A>
            ) : null
          }
        />
        <main id="main" tabIndex={-1} onFocus={showPageFocus}>
          <DockPerson value={controls.viewerHandle ?? null}>{children}</DockPerson>
        </main>
        <nav className="tabs" aria-label="Account" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {tabPlaces.map(name => (
            <A
              key={name}
              href={hrefFor({ frame: 'account', place: name })}
              aria-current={place === name ? 'page' : undefined}
            >
              <PlaceIcon name={name} size={20} />
              {accountTabLabels[name] ?? accountPlaceLabels[name]}
            </A>
          ))}
          <PhoneMore
            places={accountPlaces}
            tabs={tabPlaces}
            current={place}
            labels={accountPlaceLabels}
            href={name => hrefFor({ frame: 'account', place: name })}
          />
        </nav>
      </div>
    </RailControls.Provider>
  );
}

/** Before a first project: the top bar alone and one column. */
export function BareFrame({ controls, children }: { controls: FrameControls; children: ReactNode }) {
  return (
    <div className="shell" data-frame="bare">
      <Skip />
      <header className="top">
        <Brand href={hrefFor({ frame: 'bare', page: 'new' })} />
        <div className="fill" />
        <End handle={controls.viewerHandle} onPalette={controls.onPalette} onKeys={controls.onKeys} />
      </header>
      <main id="main" tabIndex={-1} onFocus={showPageFocus}>
        {children}
      </main>
    </div>
  );
}

/** Pages a signed-out person can reach: one column between two rules under a plain bar. */
export function PublicFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <>
      <Skip />
      <header className="pubbar">
        <a className="brand" href="/" translate="no">
          <ForgeMark size={20} />
          <span>Forge</span>
        </a>
        <div className="end">
          <a href="/docs/">Docs</a>
          <A href="/-/terms">Terms</A>
          <A href="/-/privacy">Privacy policy</A>
        </div>
      </header>
      <main className={wide ? 'pubcol wide' : 'pubcol'} id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
