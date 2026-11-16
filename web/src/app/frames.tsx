// SPDX-License-Identifier: Apache-2.0
// The four frames (DESIGN.md "Frames"): project (mark, project picker, line, Needs you, six places), account (the owner
// in the project's place, no line, the account's places), bare (no rail, no line; before a first project) and the
// public bar and column. Every control at first paint is a plain link or button; menus and sheets attach with the
// behaviour layer (decisions.md, shared-base rule 3). Each frame has a skip link, one main landmark and the phone tabs.
import type { ReactNode } from 'react';
import { Avatar, Count, Menu, State, type MenuAction } from '../ds';
import { ForgeMark } from '../shell/brand';
import { Line, heldCount, type LineFeed } from './Line';
import { useMark } from './mark';
import {
  accountPlaces,
  hrefFor,
  placeSections,
  projectPlaces,
  type AccountPlace,
  type AppRoute,
  type ProjectPlace,
} from './paths';
import {
  PlaceIcon,
  accountPlaceLabels,
  accountTabLabels,
  projectPlaceLabels,
  sectionLabels,
  stripGapBefore,
} from './places';
import { followLink, navigate } from './router';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;

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
        aria-label={handle ? `@${handle}, your account` : 'Your account'}
      >
        {handle ? <Avatar handle={`@${handle}`} /> : <span className="av none" aria-hidden="true" />}
      </A>
    </div>
  );
}

export type FrameControls = { onPalette: () => void; onKeys: () => void; viewerHandle: string | undefined };

function placeHref(route: ProjectRoute, place: ProjectPlace) {
  return hrefFor({ ...route, place, section: '', rest: '' });
}

/** The section strip of a place with more than one section. */
function Strip({ route }: { route: ProjectRoute }) {
  const sections = placeSections[route.place];
  if (sections.length < 2) return null;
  return (
    <nav className="strip" aria-label={projectPlaceLabels[route.place]}>
      {sections.map(section => (
        <span key={section || 'first'} style={{ display: 'contents' }}>
          {stripGapBefore[route.place] === section ? <span className="gap" /> : null}
          <A
            href={hrefFor({ ...route, section, rest: '' })}
            aria-current={route.section === section && !route.rest ? 'page' : undefined}
          >
            {sectionLabels[route.place][section]}
          </A>
        </span>
      ))}
    </nav>
  );
}

export function ProjectFrame({
  route,
  name,
  feed,
  projects,
  controls,
  children,
}: {
  route: ProjectRoute;
  /** The project's display name once resolved; the address slug until then. */
  name: string;
  feed: LineFeed | undefined;
  /** The project picker's entries; null until the picker is first opened. */
  projects: readonly { handle: string; slug: string; name: string }[] | null;
  controls: FrameControls & { onPicker: () => void };
  children: ReactNode;
}) {
  const held = heldCount(feed);
  const needsLabel = held === undefined ? 'Needs you' : `Needs you: ${held}`;
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
  const more = route.place === 'stats' || route.place === 'settings';
  return (
    <div className="shell" data-frame="project">
      <Skip />
      <header className="top">
        <Brand href={placeHref(route, 'needs')} feed={feed} />
        <span onPointerEnter={controls.onPicker} onFocus={controls.onPicker} style={{ display: 'contents' }}>
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
            {held === undefined ? null : <Count n={held} hot={held > 0} />}
          </A>
        </End>
      </header>
      <Line feed={feed} handle={route.handle} project={route.project} phone />
      <nav className="rail" aria-label="Project">
        {projectPlaces.map((place, index) => (
          <A
            key={place}
            href={placeHref(route, place)}
            aria-current={route.place === place ? 'page' : undefined}
            aria-keyshortcuts={String(index + 1)}
          >
            <PlaceIcon name={place} />
            <span>{projectPlaceLabels[place]}</span>
            {place === 'needs' && held ? <Count n={held} hot /> : <kbd aria-hidden="true">{index + 1}</kbd>}
          </A>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        <Strip route={route} />
        {children}
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
        <A
          href={placeHref(route, more ? route.place : 'settings')}
          aria-current={more ? 'page' : undefined}
          data-more=""
        >
          <PlaceIcon name="more" size={20} />
          More
        </A>
      </nav>
    </div>
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
  const more = place === 'devices' || place === 'data';
  return (
    <div className="shell" data-frame="account">
      <Skip />
      <header className="top">
        <Brand href={hrefFor({ frame: 'account', place: 'projects' })} />
        <span className="owner" translate="no">
          {controls.viewerHandle ? <Avatar handle={`@${controls.viewerHandle}`} /> : null}
          <span className="cut">{controls.viewerHandle ? `@${controls.viewerHandle}` : 'Your account'}</span>
        </span>
        <div className="fill" />
        <End handle={controls.viewerHandle} onPalette={controls.onPalette} onKeys={controls.onKeys} />
      </header>
      <nav className="rail" aria-label="Account">
        <div className="grp">Account</div>
        {accountPlaces.map(name => (
          <A
            key={name}
            href={hrefFor({ frame: 'account', place: name })}
            aria-current={place === name ? 'page' : undefined}
          >
            <PlaceIcon name={name} />
            <span>{accountPlaceLabels[name]}</span>
          </A>
        ))}
        {back ? (
          <A className="back" href={back.href} style={{ marginTop: 'auto' }}>
            <PlaceIcon name="back" />
            <span className="cut" translate="no">
              {back.name}
            </span>
          </A>
        ) : null}
      </nav>
      <main id="main" tabIndex={-1}>
        {children}
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
        <A
          href={hrefFor({ frame: 'account', place: more ? place : 'devices' })}
          aria-current={more ? 'page' : undefined}
        >
          <PlaceIcon name="more" size={20} />
          More
        </A>
      </nav>
    </div>
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
      <main id="main" tabIndex={-1}>
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
          <a href="https://github.com/NanthAI/nanthai-forge/blob/main/docs/README.md">Docs</a>
        </div>
      </header>
      <main className={wide ? 'pubcol wide' : 'pubcol'} id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
