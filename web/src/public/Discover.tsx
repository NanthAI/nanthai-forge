// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Public discovery (Items 8947a779, 76be0714, 875a4b60): explore, a person's or organisation's profile, and a public
// project's front page for visitors. Anyone can browse signed out; star and clone ask for sign-in (owner decision
// 2026-11-16). Every page is one read of the cached public JSON (read.ts): no Convex connection for a visitor, no
// polling. Signed in, the explore and profile rows add one read of the viewer's own stars and the star toggle.
// Everything shown here already passed the backend's visibility rule (convex/publicVisibility.ts): hidden Items,
// members-only plans and Lane titles without the owner's opt-in never reach this page. A public project's code and
// history (Item 4c164732) are the members' Code views on the same cached read (PublicCode.tsx).
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { Avatar, Glyph, Sheet, Standing, State, initials } from '../ds';
import { ForgeMark } from '../ui/brand';
import { followLink } from '../app/router';
import { stopWords } from '../app/lane-state';
import { lineStops, type LineStage } from '../app/Line';
import { hrefFor, publicProjectHref, type AppRoute } from '../app/paths';
import { shellQuote } from '../../../src/shell-quote';
import { explorePagePath, explorePageSize, orderSearchRows } from '../../../src/public-explore-pages';
import { publicProjectClone, publicProjectLogin } from '../../../src/public-project-commands';
import {
  useExploreDirectory,
  usePublicRead,
  type ExploreOrder,
  type ExplorePage,
  type ListedProject,
  type ProfilePage,
  type ProjectPage,
} from './read';
import { Person } from './Person';
import { ReportKey } from '../app/ReportKey';
import type { VisitorHistory } from '../app/code/code-data';

const PublicCode = lazy(() => import('./PublicCode'));

type Props = { route: AppRoute; signedIn: boolean; viewerHandle: string | undefined };
const DOCS = '/docs/';
const nf = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
/** A count in a narrow column: exact below 100,000, then 1.2M; the exact number stays in the label. */
const big = (n: number) => (n >= 100_000 ? compact.format(n) : nf.format(n));
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const projectHref = publicProjectHref;
const codeHref = (handle: string, slug: string) =>
  hrefFor({ frame: 'project', handle, project: slug, place: 'code', section: 'files', rest: '' });
const profileHref = (handle: string) => hrefFor({ frame: 'discover', page: 'profile', handle });
const signInHref = (next = location.pathname + location.search) =>
  `${hrefFor({ frame: 'public', page: 'signin' })}?next=${encodeURIComponent(next)}`;

export default function Discover({ route, signedIn, viewerHandle }: Props) {
  const projectNext =
    route.frame === 'project' && route.place === 'needs'
      ? projectHref(route.handle, route.project)
      : undefined;
  const page =
    route.frame === 'discover' && route.page === 'explore' ? (
      <Explore signedIn={signedIn} />
    ) : route.frame === 'discover' ? (
      <Profile handle={route.handle} signedIn={signedIn} />
    ) : route.frame === 'project' && route.place === 'code' ? (
      <Code route={route} />
    ) : route.frame === 'project' ? (
      <Project handle={route.handle} slug={route.project} signedIn={signedIn} viewerHandle={viewerHandle} />
    ) : null;
  return (
    <>
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <header className="pubbar wide">
        <a className="brand" href="/" translate="no">
          <ForgeMark size={20} />
          <span>Forge</span>
        </a>
        <nav className="pn" aria-label="Site">
          <a
            href={hrefFor({ frame: 'discover', page: 'explore' })}
            aria-current={route.frame === 'discover' && route.page === 'explore' ? 'page' : undefined}
            onClick={followLink}
          >
            Explore
          </a>
          <a className="hide-ph" href={DOCS}>
            Docs
          </a>
        </nav>
        <div className="end">
          {signedIn ? (
            <>
              <a
                className="hide-ph"
                href={hrefFor({ frame: 'account', place: 'projects' })}
                onClick={followLink}
              >
                Your projects
              </a>
              {viewerHandle ? (
                <a
                  className="acct"
                  href={profileHref(viewerHandle)}
                  aria-label={`@${viewerHandle}, your profile`}
                  onClick={followLink}
                >
                  <Avatar handle={`@${viewerHandle}`} />
                </a>
              ) : null}
            </>
          ) : (
            <a className="btn sm" href={signInHref(projectNext)} onClick={followLink}>
              Sign in
            </a>
          )}
        </div>
      </header>
      <main className="pubwide" id="main" tabIndex={-1}>
        {page}
      </main>
      <footer className="pubfoot">
        <span translate="no">Forge by NanthAI</span>
        <a href={hrefFor({ frame: 'discover', page: 'explore' })} onClick={followLink}>
          Explore
        </a>
        <a href={DOCS}>Docs</a>
        <a href="/llms.txt" translate="no">
          /llms.txt
        </a>
      </footer>
    </>
  );
}

/* ---------- shared pieces ---------- */

/** Landings per day this week, scaled to the busiest day; today is the last bar. */
function Week({ days, large = false }: { days: readonly number[]; large?: boolean }) {
  const week = days.length === 7 ? days : [0, 0, 0, 0, 0, 0, 0];
  const top = Math.max(...week);
  const said = week.map((n, i) => `${i === 6 ? 'today' : `${6 - i} days ago`} ${nf.format(n)}`).join(', ');
  return (
    <span className={large ? 'wk lg' : 'wk'} role="img" aria-label={`Landings per day: ${said}`} title={said}>
      {week.map((n, i) => (
        <i
          key={i}
          className={i === 6 ? 'now' : undefined}
          style={{ '--h': top ? Math.max((n / top) * 100, n ? 8 : 0) : 0 } as CSSProperties}
        />
      ))}
    </span>
  );
}

/** Whether main's check passes. A project that lands without a check never shows Passing. */
function Main({ main }: { main: ListedProject['main'] }) {
  return main === 'passing' ? (
    <State word="Done" state="passed">
      Passing
    </State>
  ) : (
    <State word="Not run">Not checked</State>
  );
}

const STAR = 'M8 1.9l1.85 3.9 4.25.55-3.1 3 .8 4.25L8 11.5l-3.8 2.1.8-4.25-3.1-3 4.25-.55z';
function StarGlyph() {
  return (
    <span className="g" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d={STAR} />
      </svg>
      <svg className="f" viewBox="0 0 16 16">
        <path d={STAR} />
      </svg>
    </span>
  );
}

/** Why a visitor must sign in first, titled with what they were doing. Nothing happened yet. */
function Gate({
  what,
  name,
  onClose,
  next,
}: {
  what: 'star' | 'clone';
  name: string;
  onClose: () => void;
  next?: string;
}) {
  return (
    <Sheet
      open
      onOpenChange={open => !open && onClose()}
      title={what === 'star' ? `Sign in to star ${name}` : `Sign in to clone ${name}`}
      footer={
        <>
          <a className="btn primary" href={signInHref(next)} onClick={followLink}>
            Sign in
          </a>
          <button type="button" className="btn ghost" onClick={onClose}>
            Not now
          </button>
        </>
      }
    >
      <p className="note">
        {what === 'star'
          ? 'A star is one per person, given by a person and never by an agent. Sign in, then star it.'
          : 'Cloning needs an account. Nothing was copied. Sign in, then the clone command is ready here.'}
      </p>
    </Sheet>
  );
}

/** The same account star on a project page or a discovery row. */
function ProjectStar({
  project,
  stars,
  mine,
  signedIn,
  inRow = false,
  ownStarredList = false,
  onGate,
}: {
  project: { id: string; name: string; handle: string };
  stars: number;
  mine: ReadonlySet<string> | null;
  signedIn: boolean;
  inRow?: boolean;
  ownStarredList?: boolean;
  onGate: () => void;
}) {
  const star = useMutation(api.publicDiscovery.star);
  const [given, setGiven] = useState<{ starred: boolean; stars: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const starred = ownStarredList ? (given?.starred ?? true) : Boolean(mine?.has(project.id));
  const shown = given?.stars ?? stars;
  const printed = big(shown);
  const exact = shown >= 100_000 ? ` (${nf.format(shown)})` : '';
  const press = async () => {
    if (!signedIn) return onGate();
    if ((!mine && !ownStarredList) || writing.current) return;
    writing.current = true;
    setPending(true);
    setError('');
    try {
      setGiven(await star({ projectId: project.id as Id<'hostedProjects'>, starred: !starred }));
    } catch (error) {
      const data = (error as { data?: { message?: string } })?.data;
      setError(data?.message ?? 'Could not update the star. Try again.');
    } finally {
      writing.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={inRow ? 'star in-row' : 'btn star'}
        aria-pressed={starred}
        title={starred ? 'Starred by you' : 'Star'}
        aria-disabled={signedIn && ((!mine && !ownStarredList) || pending)}
        onClick={() => void press()}
      >
        <StarGlyph />
        <span className={inRow ? 'sr' : undefined}>Star</span>{' '}
        <b className={inRow ? undefined : 'n'}>{printed}</b>
        <span className="sr">
          {` ${shown === 1 ? 'star' : 'stars'}${exact} for ${project.handle}/${project.name}`}
        </span>
      </button>
      {error ? (
        <span className="note" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

/** Projects as table rows: who and what, landings this week, main, stars. */
function Rows({
  projects,
  visibleProjects = projects,
  ownStarredList = false,
  signedIn,
  starLookup,
}: {
  projects: readonly ListedProject[];
  visibleProjects?: readonly ListedProject[];
  ownStarredList?: boolean;
  signedIn: boolean;
  starLookup?: true;
}) {
  const projectIds = useMemo(() => projects.map(project => project.id as Id<'hostedProjects'>), [projects]);
  const mineList = useQuery(
    api.publicDiscovery.myStars,
    signedIn && !ownStarredList && projectIds.length ? (starLookup ? { projectIds } : {}) : 'skip',
  );
  const mine = useMemo(() => (mineList ? new Set<string>(mineList) : null), [mineList]);
  const [gate, setGate] = useState<ListedProject | null>(null);
  if (!visibleProjects.length) return null;
  return (
    <>
      <div className="th xrow lean">
        <span>Project</span>
        <span className="r" title="Changes accepted onto main in the last 7 days, and each day’s share">
          Landings, 7 days
        </span>
        <span title="Whether the check on main passes">Main</span>
        <span className="r">Stars</span>
      </div>
      {visibleProjects.map(project => {
        const n = project.landings;
        return (
          <div className="row xrow lean" key={`${project.handle}/${project.slug}`}>
            <div className="pj">
              <Avatar handle={`@${project.handle}`} large />
              <a
                className="pjn"
                href={projectHref(project.handle, project.slug)}
                title={`${project.handle}/${project.name}`}
                translate="no"
                onClick={followLink}
              >
                <span className="ow" dir="auto">
                  {project.handle}
                </span>
                <span className="sl">/</span>
                <b dir="auto">{project.name}</b>
              </a>
              <span className="pjd">On Forge since {day.format(project.since)}</span>
            </div>
            <div className="sig">
              <span className="wkc r">
                <span className={n ? 'num' : 'num zero'}>
                  {nf.format(n)}
                  <span className="k"> this week</span>
                </span>
                <Week days={project.days} />
              </span>
              <span className="hl">
                <Main main={project.main} />
              </span>
            </div>
            <div className="stc">
              <ProjectStar
                project={project}
                stars={project.stars}
                mine={mine}
                signedIn={signedIn}
                inRow
                ownStarredList={ownStarredList}
                onGate={() => setGate(project)}
              />
            </div>
          </div>
        );
      })}
      {gate ? <Gate what="star" name={gate.name} onClose={() => setGate(null)} /> : null}
    </>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <div className="head" aria-busy="true">
      <h1>{what}</h1>
      <p className="sit">Loading…</p>
    </div>
  );
}

function Failed({ what, retry }: { what: string; retry: () => void }) {
  return (
    <>
      <div className="head">
        <h1>{what}</h1>
        <p className="sit">
          <b>This page could not be loaded.</b> Forge could not be reached.
        </p>
      </div>
      <div className="notice" data-st="failed">
        <State word="Check failed">Could not load</State>
        <p>Nothing you starred is lost.</p>
        <button type="button" className="btn sm" onClick={retry}>
          Retry
        </button>
      </div>
    </>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="empty">
      <h1 className="sr">Not found</h1>
      <h3>{what}</h3>
      <p>
        The address may be mistyped, or it is private, renamed or removed. Private projects are never listed.
      </p>
      <a className="btn" href={hrefFor({ frame: 'discover', page: 'explore' })} onClick={followLink}>
        Explore public projects
      </a>
    </div>
  );
}

/* ---------- explore ---------- */

const ORDERS: Record<ExploreOrder, [string, string]> = {
  active: ['Active', 'most active first: landings this week; an unchecked main ranks lower'],
  stars: ['Stars', 'most starred first'],
  newest: ['Newest', 'newest public project first'],
};

function Explore({ signedIn }: { signedIn: boolean }) {
  const [order, setOrder] = useState<ExploreOrder>('active');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [start, setStart] = useState(0);
  const changeQuery = (text: string) => {
    setQuery(text);
    setStart(0);
  };
  const [read, retry] = usePublicRead<ExplorePage>(explorePagePath(order, page));
  const term = query.trim().toLowerCase();
  const directory = useExploreDirectory(
    read.state === 'ok' && read.data.order === order ? read.data : undefined,
    Boolean(term),
  );
  if (
    read.state === 'loading' ||
    (read.state === 'ok' && (read.data.order !== order || (read.data.page ?? 1) !== page))
  )
    return <Loading what="Explore" />;
  if (read.state !== 'ok') return <Failed what="Explore" retry={retry} />;
  const { total, more, projects } = read.data;
  const useIndex = Boolean(term && read.data.search);
  const matchesAddress = (handle: string, slug: string, name: string) =>
    [handle, name, slug, `${handle}/${slug}`].some(text => text.toLowerCase().includes(term));
  const indexed = useIndex ? (directory.projects ?? []) : [];
  const hits = indexed
    .filter(([handle, slug, name]) => matchesAddress(handle, slug, name))
    .sort((a, b) => orderSearchRows(order, a, b));
  const shown = useIndex
    ? []
    : term
      ? projects.filter(({ handle, slug, name }) => matchesAddress(handle, slug, name))
      : projects;
  const active = read.data.page ? read.data.active : projects.filter(project => project.landings > 0).length;
  const searchHits = hits.slice(start, start + explorePageSize);
  const counts = new Map<string, number>();
  if (term)
    for (const handle of useIndex ? indexed.map(row => row[0]) : projects.map(project => project.handle)) {
      if (handle.includes(term)) counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }
  const people = [...counts.keys()];
  return (
    <>
      <div className="head">
        <h1>Explore</h1>
        <p className="sit">
          {total === 0 ? (
            <b>No public projects yet.</b>
          ) : (
            <>
              <b>
                {plural(total, 'public project')}
                {more && !read.data.page ? ' and more' : ''}.
              </b>
              {active !== undefined ? ` ${nf.format(active)} of them landed something this week.` : ''}
            </>
          )}
        </p>
      </div>
      <section className="region" aria-label="Public projects">
        <form className="tbar" role="search" onSubmit={event => event.preventDefault()}>
          <label className="find">
            <span className="sr">Find a project, person or organisation</span>
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.3 10.3 14 14" strokeWidth="1.5" />
            </svg>
            <input
              className="inp"
              type="search"
              name="q"
              autoComplete="off"
              spellCheck={false}
              placeholder="Find a project, person or organisation…"
              value={query}
              onChange={event => changeQuery(event.target.value)}
            />
          </label>
          <div className="seg" role="group" aria-label="Order">
            {(Object.keys(ORDERS) as ExploreOrder[]).map(key => (
              <button
                key={key}
                type="button"
                aria-pressed={key === order}
                onClick={() => {
                  setOrder(key);
                  setPage(1);
                  setStart(0);
                }}
              >
                {ORDERS[key][0]}
              </button>
            ))}
          </div>
          <span className="n">
            {useIndex && directory.projects === undefined
              ? 'Searching…'
              : plural(useIndex ? hits.length : shown.length, 'project')}
          </span>
        </form>
        {people.length ? (
          <>
            <div className="band">
              <span>People and organisations</span>
              <span className="cnt">{people.length}</span>
            </div>
            {people.map(handle => (
              <a className="row hitrow" key={handle} href={profileHref(handle)} onClick={followLink}>
                <Avatar handle={`@${handle}`} large />
                <span className="ttl mono">@{handle}</span>
                <span className="meta">{plural(counts.get(handle) ?? 0, 'public project')}</span>
              </a>
            ))}
            <div className="band">
              <span>Projects</span>
              <span className="cnt">{useIndex ? hits.length : shown.length}</span>
            </div>
          </>
        ) : null}
        {shown.length ? (
          <Rows projects={shown} signedIn={signedIn} starLookup={read.data.starLookup} />
        ) : null}
        {searchHits.map(([handle, slug, name]) => (
          <a
            className="row hitrow"
            href={projectHref(handle, slug)}
            onClick={followLink}
            key={`${handle}/${slug}`}
          >
            <Avatar handle={`@${handle}`} large />
            <span className="ttl" translate="no">
              {handle}/{name || slug}
            </span>
          </a>
        ))}
        {useIndex && directory.projects === null ? (
          <Failed what="Explore search" retry={directory.retry} />
        ) : null}
        {term && (!useIndex || directory.projects) && !hits.length && !shown.length && !people.length ? (
          <div className="empty">
            <h3>No match for “{query.trim()}”</h3>
            <p>Handles and project names are searched. Private projects are never listed here.</p>
            <button type="button" className="btn" onClick={() => changeQuery('')}>
              Clear the search
            </button>
          </div>
        ) : null}
        {useIndex && hits.length > explorePageSize ? (
          <div className="pager">
            <span className="n">
              {nf.format(start + 1)} to {nf.format(start + searchHits.length)} of {nf.format(hits.length)}
            </span>
            {start > 0 ? (
              <button type="button" className="btn sm" onClick={() => setStart(start - explorePageSize)}>
                Previous 50
              </button>
            ) : null}
            {start + searchHits.length < hits.length ? (
              <button type="button" className="btn sm" onClick={() => setStart(start + explorePageSize)}>
                Next 50
              </button>
            ) : null}
          </div>
        ) : null}
        {!term && shown.length ? (
          <div className="pager">
            <span className="n">
              {nf.format((read.data.start ?? 0) + 1)} to {nf.format((read.data.start ?? 0) + shown.length)} of{' '}
              {nf.format(total)}
              {more && !read.data.page ? '+' : ''} · {ORDERS[order][1]}
            </span>
            {page > 1 ? (
              <button type="button" className="btn sm" onClick={() => setPage(page - 1)}>
                Previous page
              </button>
            ) : null}
            {more && read.data.page ? (
              <button type="button" className="btn sm" onClick={() => setPage(page + 1)}>
                Next page
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </>
  );
}

/* ---------- profile ---------- */

function Profile({ handle, signedIn }: { handle: string; signedIn: boolean }) {
  const [read, retry] = usePublicRead<ProfilePage>(`profile/${encodeURIComponent(handle)}.json`);
  if (read.state === 'loading') return <Loading what={`@${handle}`} />;
  if (read.state === 'missing') return <NotFound what={`No one at @${handle}`} />;
  if (read.state !== 'ok') return <Failed what={`@${handle}`} retry={retry} />;
  const { projects } = read.data;
  return (
    <Person
      handle={read.data.handle}
      signedIn={signedIn}
      publicRead={read.data.contributions}
      projectCount={projects.length}
      rows={listed => <Rows projects={listed} signedIn={signedIn} ownStarredList />}
      projects={
        <section className="region" aria-label="Public projects">
          <div className="ph">
            <h2>Public projects</h2>
            <span className="cnt">{projects.length}</span>
            <span className="hint">most starred first</span>
          </div>
          {projects.length ? (
            <Rows projects={projects} signedIn={signedIn} starLookup={read.data.starLookup} />
          ) : (
            <p className="quietline">Nothing public here yet. Private projects are never listed.</p>
          )}
          {read.data.moreCount ? (
            <p className="quietline">{nf.format(read.data.moreCount)} more public entries are not shown.</p>
          ) : null}
        </section>
      }
    />
  );
}

/* ---------- a public project's front page ---------- */

/** The line's stops (Line.tsx `lineStops`), so a visitor and a member name and count a Lane's place the same way. */
const STOPS = lineStops.map(stop => [stop.stage, stop.label, stop.of] as const);
const isStop = (stage: string): stage is LineStage => stage in stopWords;

function Project({
  handle,
  slug,
  signedIn,
  viewerHandle,
}: {
  handle: string;
  slug: string;
  signedIn: boolean;
  viewerHandle: string | undefined;
}) {
  const [read, retry] = usePublicRead<ProjectPage>(
    `project/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}.json`,
  );
  const [sheet, setSheet] = useState<'star' | 'clone' | 'share' | 'stargazers' | null>(null);
  const data = read.state === 'ok' ? read.data : null;
  const id = data ? (data.project.id as Id<'hostedProjects'>) : null;
  const mineList = useQuery(
    api.publicDiscovery.myStars,
    signedIn && id ? (data?.starLookup ? { projectIds: [id] } : {}) : 'skip',
  );
  const mine = useMemo(() => (mineList ? new Set<string>(mineList) : null), [mineList]);
  if (read.state === 'loading') return <Loading what={`${handle}/${slug}`} />;
  if (read.state === 'missing') return <NotFound what="No public project at this address" />;
  if (read.state !== 'ok') return <Failed what={`${handle}/${slug}`} retry={retry} />;
  const { project, activity, lanes, plan, stars } = read.data;
  const workspace = `${location.origin}${hrefFor({
    frame: 'project',
    handle: project.handle,
    project: project.slug,
    place: 'needs',
    section: '',
    rest: '',
  })}`;
  const link = `${location.origin}${projectHref(project.handle, project.slug)}`;
  const owner = signedIn && viewerHandle === project.handle;
  const facts: ReactNode[] = [
    <span key="main">
      {activity.main === 'passing' ? <b>Main is passing.</b> : <b>Main is not checked.</b>}
    </span>,
    ` ${plural(activity.landings, 'change')} ${activity.recordedSince ? 'recorded this week' : 'landed this week'}. `,
    `${plural(lanes.open, 'Lane')} ${lanes.open === 1 ? 'is' : 'are'} open now`,
    plan.shown ? ` and ${plural(plan.left, 'Item')} ${plan.left === 1 ? 'is' : 'are'} left.` : '.',
  ];
  return (
    <>
      <div className="phead">
        <span className="av pro" aria-hidden="true">
          {initials(`@${project.handle}`)}
        </span>
        <div className="id">
          <h1 translate="no">
            <a className="ow" href={profileHref(project.handle)} onClick={followLink}>
              {project.handle}
              <i>/</i>
            </a>
            {project.name}
            <span className="kind">Public</span>
          </h1>
          <div className="fl">
            <span>On Forge since {day.format(project.since)}</span>
            {project.upstream ? (
              <span>
                Forked from{' '}
                <a href={projectHref(project.upstream.handle, project.upstream.slug)} onClick={followLink}>
                  {project.upstream.handle}/{project.upstream.slug}
                </a>
              </span>
            ) : project.upstream === null ? (
              <span>Forked from a project that is no longer available</span>
            ) : null}
          </div>
        </div>
        <div className="tools">
          <ProjectStar
            key={`${project.id}:${viewerHandle ?? ''}`}
            project={project}
            stars={stars}
            mine={mine}
            signedIn={signedIn}
            onGate={() => setSheet('star')}
          />
          <a className="btn" href={codeHref(project.handle, project.slug)} onClick={followLink}>
            Browse the code
          </a>
          <button type="button" className="btn" onClick={() => setSheet('share')}>
            Share
          </button>
          <button type="button" className="btn primary" onClick={() => setSheet('clone')}>
            Clone
          </button>
          {signedIn ? (
            <a className="btn" href={workspace} onClick={followLink}>
              Open workspace
            </a>
          ) : null}
          {signedIn && !owner && id ? <ReportKey projectId={id} target={{ target: 'project' }} /> : null}
        </div>
      </div>
      <div className="glance">
        <p>{facts}</p>
        <span className="asof">as of {clock.format(read.data.asOf)}</span>
      </div>
      {read.data.moreCount ? (
        <p className="quietline">{nf.format(read.data.moreCount)} more public entries are not shown.</p>
      ) : null}
      {plan.shown ? (
        <Standing
          of="public"
          done={{
            n: activity.landings,
            ...(activity.recordedSince
              ? { more: `recorded since ${day.format(activity.recordedSince)}` }
              : {}),
          }}
          inProgress={{ n: lanes.open, ...(lanes.held ? { more: `${nf.format(lanes.held)} held` } : {}) }}
          left={{
            n: plan.left,
            ...(plan.inProgress ? { more: `${nf.format(plan.inProgress)} in progress` } : {}),
          }}
        />
      ) : null}
      <div className="pframe">
        <div className="doc">
          <PlanSections plan={plan} />
          <section aria-label="Open Lanes">
            <div className="ph">
              <h2>Open Lanes</h2>
              <span className="cnt">{lanes.more ? '100+' : lanes.open}</span>
              <span className="hint">where each one is on its way to main</span>
            </div>
            <div className="pstops">
              {STOPS.map(([stop, label, of]) => {
                const n = of.reduce((sum, stage) => sum + (lanes[stage] ?? 0), 0);
                return (
                  <div key={stop} className={n ? undefined : 'z'}>
                    {label}
                    <b>{nf.format(n)}</b>
                  </div>
                );
              })}
              <div className="mn">
                {activity.recordedSince ? 'Recorded' : 'Landed'}
                <b
                  title={
                    activity.recordedSince
                      ? `Recorded since ${new Date(activity.recordedSince).toLocaleDateString()}`
                      : undefined
                  }
                >
                  {nf.format(activity.landings)}
                </b>
              </div>
            </div>
            {lanes.titles.length ? (
              lanes.titles.map((lane, i) => (
                <div className="row" key={i}>
                  <span className="ttl" dir="auto">
                    {lane.title ?? 'A Lane'}
                  </span>
                  <span className="meta">
                    {isStop(lane.stage) ? `${stopWords[lane.stage]}${lane.held ? ', held' : ''}` : lane.stage}
                  </span>
                </div>
              ))
            ) : lanes.open ? (
              <p className="quietline">This project shows open Lanes as counts.</p>
            ) : (
              <p className="quietline">No Lane is open now.</p>
            )}
          </section>
        </div>
        <aside aria-label="About">
          <section>
            <div className="ph">
              <h2>About</h2>
            </div>
            <dl className="kv about">
              <dt>Owner</dt>
              <dd>
                <a href={profileHref(project.handle)} onClick={followLink} translate="no">
                  @{project.handle}
                </a>
              </dd>
              <dt>Since</dt>
              <dd>{day.format(project.since)}</dd>
              <dt>{activity.recordedSince ? 'Recorded this week' : 'This week'}</dt>
              <dd>
                {plural(activity.landings, 'landing')} <Week days={activity.days} />
              </dd>
              <dt>Main</dt>
              <dd>
                <Main main={activity.main} />
              </dd>
              {owner ? (
                <>
                  <dt>Stars</dt>
                  <dd>
                    <button type="button" className="btn sm" onClick={() => setSheet('stargazers')}>
                      Who starred
                    </button>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        </aside>
      </div>
      {sheet === 'star' || (sheet === 'clone' && !signedIn) ? (
        <Gate
          what={sheet}
          name={project.name}
          next={projectHref(project.handle, project.slug)}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'clone' && signedIn ? (
        <CloneProject
          project={project}
          link={workspace}
          deployment={read.data.deployment}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'stargazers' && owner && id ? <Stargazers id={id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'share' ? (
        <Sheet
          open
          onOpenChange={open => !open && setSheet(null)}
          title={`Share ${project.name}`}
          footer={
            <button type="button" className="btn ghost" onClick={() => setSheet(null)}>
              Close
            </button>
          }
        >
          <div className="cmd mono">
            <code>{link}</code>
            <button
              type="button"
              className="btn sm"
              onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}
            >
              Copy the link
            </button>
          </div>
          <p className="note">
            A link preview shows the project’s name, this week’s landings and whether main passes.
          </p>
        </Sheet>
      ) : null}
    </>
  );
}

function CloneProject({
  project,
  link,
  deployment,
  onClose,
}: {
  project: ProjectPage['project'];
  link: string;
  deployment?: string;
  onClose: () => void;
}) {
  return (
    <Sheet
      open
      onOpenChange={open => !open && onClose()}
      title={`Clone ${project.name}`}
      footer={
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {deployment ? (
        <>
          <p>If this device needs approval, run:</p>
          <div className="cmd mono">
            <code>{publicProjectLogin(deployment)}</code>
          </div>
          <p>Clone the project:</p>
          <div className="cmd mono">
            <code>{publicProjectClone(link, project.slug, deployment)}</code>
          </div>
        </>
      ) : (
        <>
          <p>Find the clone and device approval commands for this site:</p>
          <div className="cmd mono">
            <code>{`nforge clone --find ${shellQuote(`${project.handle}/${project.slug}`)} --site ${shellQuote(location.origin)}`}</code>
          </div>
        </>
      )}
    </Sheet>
  );
}

type StargazerPage = FunctionReturnType<typeof api.publicDiscovery.stargazers>;

function Stargazers({ id, onClose }: { id: Id<'hostedProjects'>; onClose: () => void }) {
  const client = useConvex();
  const [handles, setHandles] = useState<StargazerPage['page']>([]);
  const [request, setRequest] = useState({ cursor: null as string | null, attempt: 0 });
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let live = true;
    void client
      .query(api.publicDiscovery.stargazers, {
        projectId: id,
        paginationOpts: { cursor: request.cursor, numItems: 25 },
      })
      .then(
        result => {
          if (!live) return;
          setHandles(previous => (request.cursor ? [...previous, ...result.page] : result.page));
          setNext(result.isDone ? null : result.continueCursor);
          setStatus('ready');
        },
        () => live && setStatus('failed'),
      );
    return () => {
      live = false;
    };
  }, [client, id, request]);
  const load = (cursor: string | null) => {
    setStatus('loading');
    setRequest(previous => ({ cursor, attempt: previous.attempt + 1 }));
  };
  return (
    <Sheet
      open
      onOpenChange={open => !open && onClose()}
      title="Who starred"
      footer={
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {handles.length ? (
        <ul>
          {handles.map(({ handle }) => (
            <li key={handle}>
              <a href={profileHref(handle)} onClick={followLink}>
                @{handle}
              </a>
            </li>
          ))}
        </ul>
      ) : status === 'ready' && !next ? (
        <p>No one has starred this project yet.</p>
      ) : null}
      {status === 'loading' ? <p role="status">Reading stars…</p> : null}
      {status === 'failed' ? (
        <>
          <p role="alert">Could not read who starred this project.</p>
          <button type="button" className="btn sm" onClick={() => load(request.cursor)}>
            Retry
          </button>
        </>
      ) : null}
      {status === 'ready' && next ? (
        <button type="button" className="btn sm" onClick={() => load(next)}>
          Show more
        </button>
      ) : null}
    </Sheet>
  );
}

/** A public project's code and history: the first history page names the project and main, then the Code views. */
function Code({ route }: { route: Extract<AppRoute, { frame: 'project' }> }) {
  const what = `${route.handle}/${route.project}`;
  // The site keeps data addresses in lower case; asking in that form skips its redirect.
  const base = `code/${encodeURIComponent(route.handle.toLowerCase())}/${encodeURIComponent(route.project.toLowerCase())}`;
  const [read, retry] = usePublicRead<VisitorHistory>(`${base}/history.json`);
  if (read.state === 'loading') return <Loading what={what} />;
  if (read.state === 'missing') return <NotFound what="No public project at this address" />;
  if (read.state !== 'ok') return <Failed what={what} retry={retry} />;
  return (
    <Suspense fallback={<Loading what={what} />}>
      <PublicCode route={route} base={base} first={read.data} />
    </Suspense>
  );
}

/** What is left: the next Items in the project's order and the Initiatives with Items left. */
function PlanSections({ plan }: { plan: ProjectPage['plan'] }) {
  if (!plan.shown)
    return (
      <section aria-label="Plan">
        <div className="ph">
          <h2>Plan</h2>
        </div>
        <p className="quietline">This project’s plan is for its members.</p>
      </section>
    );
  return (
    <>
      <section aria-label="Next">
        <div className="ph">
          <h2>Next</h2>
          <span className="cnt">{plan.next.length}</span>
          <span className="hint">
            {plan.left
              ? `the first ${plural(plan.next.length, 'Planned Item')} of ${nf.format(plan.left)} left, in the project’s order`
              : 'nothing left'}
          </span>
        </div>
        {plan.next.length ? (
          plan.next.map(item => (
            <div className="row item" key={item.id}>
              <span className="st" data-st="stale" title="Planned">
                <Glyph of="planned" />
                <span className="sr">Planned:</span>
              </span>
              <span className="ttl" dir="auto">
                {item.title}
              </span>
              <span className="meta" dir="auto">
                {item.initiative ?? ''}
              </span>
            </div>
          ))
        ) : (
          <p className="quietline">
            {plan.left ? 'Every Item left is already in progress or proposed.' : 'Nothing planned is left.'}
          </p>
        )}
      </section>
      {plan.initiatives.length ? (
        <section aria-label="Initiatives">
          <div className="ph">
            <h2>Initiatives</h2>
            <span className="cnt">{plan.initiatives.length}</span>
            <span className="hint">with Items left</span>
          </div>
          {plan.initiatives.map(initiative => (
            <div className="row init" key={initiative.id}>
              <span className="ttl" dir="auto">
                {initiative.title}
              </span>
              <span className="meta">
                {plural(initiative.left, 'Item')} left
                {initiative.inProgress ? ` · ${nf.format(initiative.inProgress)} in progress` : ''}
              </span>
              <span />
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
