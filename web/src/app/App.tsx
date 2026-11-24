// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The rebuilt app (Item 84125787): the four frames at the site root, signed in with Convex Auth. The Convex client sleeps
// with the tab (live-reads.ts) and holds token refresh while asleep (auth-hold.ts), so an idle or hidden tab makes no
// calls. Each page sends one bounded read for its frame: the project frame resolves its address and then reads the
// line; the account and public frames read only the viewer.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react';
import {
  ConvexReactClient,
  useConvex,
  useConvexAuth,
  useConvexConnectionState,
  useMutation,
  useQuery,
} from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { prefetchLayerWhenIdle } from '../ds';
import { takeLinkCode } from '../device/link-code';
import { captureConvexFailures } from '../error-capture';
import { liveReads } from '../live-reads';
import { signedInHint } from './signed-in-hint';
import { useLiveLine } from './use-live-line';
import { withRefreshHold } from './auth-hold';
import { Device } from './Device';
import { AccountFrame, BareFrame, ProjectFrame, PublicFrame, type FrameControls } from './frames';
import { needsCount, needsRead, needsYouLanes, waitingLanes } from './needs/count';
import { Keys, useFrameKeys, type Go } from './keys';
import { oldAddress, type OldAddress } from './old-address';
import { hrefFor, isPublicProjectView, parseAppPath, signInHref, type AppRoute } from './paths';
import { Head } from './Place';
import { AccountScreen, PlaceScreen } from './screens';
import { followLink, navigate, useRoute, useSearch } from './router';
import { forget, recall, safeNext } from './session';
import { FirstPasskey, SignIn } from './SignIn';
import './app.css';
const Legal = lazy(() => import('./Legal'));
const ApproveRedirect = lazy(() =>
  import('./ApproveRedirect').then(module => ({ default: module.ApproveRedirect })),
);
const OldAddressPage = lazy(() => import('./OldAddress'));
const loadingPlace = (
  <p className="quietline" aria-busy="true">
    Loading…
  </p>
);

// Explore, profiles and a public project's front page for visitors: one chunk, loaded with its route (Item 8947a779).
const Discover = lazy(() => import('../public/Discover'));

// Rebuilt places load with their route, never in the first paint.
const Start = lazy(() => import('./start/Start'));
const ImportRepository = lazy(() => import('./start/ImportRepository'));

document.documentElement.dataset.ds = '';
// Safe areas (phone tabs, notch): only the rebuilt frames draw into them, so only they ask for the full screen.
document
  .querySelector('meta[name="viewport"]')
  ?.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
// A device code in a link leaves the address before anything renders, so the sign-in return address never carries it;
// the device page reads it back from this tab (link-code.ts).
const arrived = parseAppPath(location.pathname);
if (arrived.frame === 'public' && arrived.page === 'device') takeLinkCode();

function makeClient() {
  const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!url) return null;
  const real = captureConvexFailures(new ConvexReactClient(url, { unsavedChangesWarning: false }));
  return withRefreshHold(liveReads.client(real), liveReads);
}

export default function App() {
  const route = useRoute();
  if (route.frame === 'public' && (route.page === 'terms' || route.page === 'privacy'))
    return (
      <Suspense fallback={loadingPlace}>
        <Legal page={route.page} />
      </Suspense>
    );
  return <ConnectedApp />;
}
function ConnectedApp() {
  const [client] = useState(makeClient);
  // The provider clears auth in its own unmount effect before the socket closes.
  useEffect(() => () => queueMicrotask(() => void client?.close()), [client]);
  useEffect(() => liveReads.watchActivity(), []);
  useEffect(() => prefetchLayerWhenIdle(), []);
  if (!client)
    return (
      <PublicFrame>
        <div className="intro">
          <h1>Forge backend is not configured</h1>
          <p>Set VITE_CONVEX_URL for this development build.</p>
        </div>
      </PublicFrame>
    );
  return (
    <ConvexAuthProvider
      client={client}
      api={{
        refreshSession: api.auth.refreshSession,
        signOut: api.auth.signOut,
        isAuthenticated: api.auth.isAuthenticated,
      }}
    >
      <Pages />
    </ConvexAuthProvider>
  );
}

function finishPasskeyStep(next: string) {
  forget();
  navigate(next, { replace: true });
}

let lastProject: { href: string; name: string } | null = null;

function Pages() {
  const route = useRoute();
  const search = useSearch();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const signingOutTo = useRef<{ href: string } | null>(null);
  const viewer = useQuery(api.urlAccounts.current, isAuthenticated ? {} : 'skip');
  // Anyone can browse signed out: explore, profiles, a project's front page (owner decision 2026-11-16) and its code
  // and history, read only (Item 4c164732). A private or missing project answers "No public project" alike.
  // An old id-only address (old-address.ts) is neither: it needs the reader's own access to resolve it.
  const look = oldAddress(location.pathname, location.search);
  const resolving = look?.kind === 'look' ? look : null;
  const discovering =
    !resolving &&
    (route.frame === 'discover' || isPublicProjectView(route, isAuthenticated, search.get('view')));
  const needsSignIn =
    !isLoading &&
    !isAuthenticated &&
    !discovering &&
    !(route.frame === 'public' && ['signin', 'terms', 'privacy'].includes(route.page));
  // The public page (web/index.html) opens the app for a browser that last had a session.
  useEffect(() => {
    if (!isLoading) signedInHint(isAuthenticated);
  }, [isLoading, isAuthenticated]);
  // The auth state owns the redirect. A late sign-out response cannot interrupt the next sign-in.
  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    const destination = signingOutTo.current;
    if (destination) {
      signingOutTo.current = null;
      lastProject = null;
      navigate(destination.href, { replace: true });
    } else if (needsSignIn) {
      navigate(signInHref(location.pathname + location.search), { replace: true });
    }
  }, [isLoading, isAuthenticated, needsSignIn]);
  useEffect(() => {
    if (
      import.meta.env.VITE_FORGE_POSTHOG_PROJECT_TOKEN &&
      !isLoading &&
      !needsSignIn &&
      (route.frame !== 'project' || discovering)
    )
      void import('../product-analytics')
        .then(({ captureBrowserAnalytics }) => captureBrowserAnalytics('screen_opened', route))
        .catch(() => undefined);
  }, [isLoading, needsSignIn, route, discovering]);
  if (isLoading || needsSignIn) return null;
  if (discovering)
    return (
      <Suspense fallback={null}>
        <Discover route={route} signedIn={isAuthenticated} viewerHandle={viewer?.handle} />
      </Suspense>
    );
  if (route.frame === 'public') {
    if (route.page === 'terms' || route.page === 'privacy')
      return (
        <Suspense fallback={loadingPlace}>
          <Legal page={route.page} />
        </Suspense>
      );
    if (route.page === 'signin') return isAuthenticated ? <AfterSignIn /> : <SignIn />;
    if (route.page === 'passkey') return <FirstPasskey onDone={finishPasskeyStep} />;
    if (route.page === 'approve')
      return (
        <Suspense fallback={null}>
          <ApproveRedirect search={search} />
        </Suspense>
      );
    return <Device viewerHandle={viewer?.handle} />;
  }
  const leave = (next?: string) => {
    if (signingOutTo.current) return;
    const destination = { href: signInHref(next) };
    signingOutTo.current = destination;
    forget();
    void signOut().catch(error => {
      if (signingOutTo.current === destination) signingOutTo.current = null;
      throw error;
    });
  };
  return <SignedIn route={route} resolving={resolving} viewerHandle={viewer?.handle} leave={leave} />;
}

/** Signed in on the sign-in page: name the account once, then go on (or offer a first passkey after GitHub). */
function AfterSignIn() {
  const search = useSearch();
  const ensure = useMutation(api.urlAccounts.ensure);
  const pending = useRef(recall());
  const github = pending.current?.method === 'github';
  const passkeys = useQuery(api.auth.listPasskeys, github ? {} : 'skip');
  const started = useRef(false);
  useEffect(() => {
    if (started.current || (github && passkeys === undefined)) return;
    started.current = true;
    const seed =
      pending.current?.method === 'passkey' && pending.current.handle
        ? { username: pending.current.handle }
        : {};
    const next = pending.current?.next ?? safeNext(search.get('next'));
    const firstPasskey = github && 'passkeys' in passkeys! && passkeys.passkeys.length === 0;
    void ensure(seed)
      .catch(() => undefined)
      .then(() => {
        if (firstPasskey) return navigate(hrefFor({ frame: 'public', page: 'passkey' }), { replace: true });
        forget();
        navigate(next, { replace: true });
      });
  }, [github, passkeys]);
  return (
    <PublicFrame>
      <div className="intro" aria-busy="true">
        <h1>Signing you in…</h1>
      </div>
    </PublicFrame>
  );
}

function SignedIn({
  route,
  resolving,
  viewerHandle,
  leave,
}: {
  route: Exclude<AppRoute, { frame: 'public' }>;
  resolving: Extract<OldAddress, { kind: 'look' }> | null;
  viewerHandle: string | undefined;
  leave: (next?: string) => void;
}) {
  const client = useConvex();
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const go: Go = {
    route,
    openPalette: () => setPalette(true),
    openKeys: () => setKeys(true),
    signOut: () => leave(),
  };
  useFrameKeys(go);
  const controls: FrameControls = { onPalette: go.openPalette, onKeys: go.openKeys, viewerHandle };
  const overlays = (projectId?: Id<'hostedProjects'> | null) => (
    <Keys
      go={go}
      palette={palette}
      setPalette={setPalette}
      keys={keys}
      setKeys={setKeys}
      projectId={projectId}
    />
  );
  if (resolving)
    return (
      <BareFrame controls={controls}>
        <Suspense fallback={null}>
          <OldAddressPage look={resolving} />
        </Suspense>
        {overlays()}
      </BareFrame>
    );
  if (route.frame === 'project') return <ProjectView route={route} controls={controls} overlays={overlays} />;
  if (route.frame === 'account')
    return (
      <AccountFrame place={route.place} back={lastProject} controls={controls}>
        <AccountScreen
          place={route.place}
          handle={viewerHandle}
          leave={() => leave(route.place === 'people' ? hrefFor(route) : undefined)}
        />
        {overlays()}
      </AccountFrame>
    );
  if (route.frame === 'bare')
    return (
      <BareFrame controls={controls}>
        <Suspense fallback={null}>
          {route.page === 'import' ? <ImportRepository /> : <Start connectionClient={client} />}
        </Suspense>
        {overlays()}
      </BareFrame>
    );
  return (
    <BareFrame controls={controls}>
      <Head
        trail={[{ label: 'No page at this address' }]}
        sentence="The address may be mistyped, or the page has moved."
      >
        <a className="btn sm" href={hrefFor({ frame: 'account', place: 'projects' })} onClick={followLink}>
          Your projects
        </a>
      </Head>
      {overlays()}
    </BareFrame>
  );
}

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
// A Lane's landing check (Item b030c3c5) loads with its route.
type PickerEntry = { handle: string; slug: string; name: string };

function ProjectView({
  route,
  controls,
  overlays,
}: {
  route: ProjectRoute;
  controls: FrameControls;
  overlays: (projectId?: Id<'hostedProjects'> | null) => React.ReactNode;
}) {
  const client = useConvex();
  const project = useQuery(api.urlProjects.resolve, { handle: route.handle, slug: route.project });
  const projectId = (project?.id ?? null) as Id<'hostedProjects'> | null;
  useEffect(() => {
    if (import.meta.env.VITE_FORGE_POSTHOG_PROJECT_TOKEN && projectId)
      void import('../product-analytics')
        .then(({ captureBrowserAnalytics }) => captureBrowserAnalytics('screen_opened', route, projectId))
        .catch(() => undefined);
  }, [route, projectId]);
  // Needs me's Flow checks share the line subscription; other places watch just the line.
  const showFlow = route.place === 'needs' && !route.section;
  const { value: line, error: lineError } = useLiveLine(projectId, showFlow);
  const connection = useConvexConnectionState();
  const feedError = !!lineError || (connection.hasEverConnected && !connection.isWebSocketConnected);
  const [lastLine, setLastLine] = useState({ projectId, line, at: Date.now() });
  if (lastLine.projectId !== projectId || (line && lastLine.line !== line)) {
    setLastLine({ projectId, line, at: Date.now() });
  }
  const feed = line ?? (lastLine.projectId === projectId ? lastLine.line : undefined);
  // The shell's "Needs you" count uses Needs me's own read and rule (needs/count.ts), so the two always agree; on
  // Needs me the page shares this one subscription.
  const needsLive = useQuery(
    needsRead,
    project?.id ? { projectId: project.id as Id<'hostedProjects'> } : 'skip',
  );
  // A parked Lane with no one named counts once 4 h idle, by the time the read arrived (count.ts parkShown).
  const needs = useMemo(() => needsCount(needsLive, Date.now()), [needsLive]);
  // The Lanes behind that count, for the top bar's line and F: one rule, so none of them can disagree with it.
  const waiting = useMemo(() => waitingLanes(needsYouLanes(needsLive, Date.now())), [needsLive]);
  const [picker, setPicker] = useState<readonly PickerEntry[] | null>(null);
  const asked = useRef(false);
  const name = project?.name ?? route.project;
  // Item eb631a53: an old address (renamed project) opens the project at its current address.
  const moved = project && (project.handle !== route.handle || project.slug !== route.project);
  useEffect(() => {
    if (moved)
      navigate(
        `${hrefFor({ ...route, handle: project.handle, project: project.slug })}${location.search}${location.hash}`,
        {
          replace: true,
        },
      );
  }, [moved, project, route]);
  if (project) lastProject = { href: hrefFor({ ...route, place: 'needs', section: '', rest: '' }), name };
  // The picker's entries: one page of the viewer's projects, read once on the first intent to open it.
  const onPicker = () => {
    if (asked.current) return;
    asked.current = true;
    void client
      .query(api.projectBackups.list, { paginationOpts: { numItems: 20, cursor: null } })
      .then(page =>
        setPicker(
          page.page.flatMap(item =>
            item.handle && item.slug ? [{ handle: item.handle, slug: item.slug, name: item.name }] : [],
          ),
        ),
      )
      .catch(() => (asked.current = false));
  };
  if (project === null)
    return (
      <BareFrame controls={controls}>
        <Head trail={[{ label: 'Project not found' }]} sentence="It may be private, renamed or removed." />
        {overlays()}
      </BareFrame>
    );
  return (
    <ProjectFrame
      route={route}
      projectId={projectId}
      name={name}
      feed={feed}
      needs={needs}
      secrets={needsLive?.secrets}
      waiting={waiting}
      projects={picker}
      controls={{ ...controls, onPicker }}
    >
      <PlaceScreen
        route={route}
        projectId={(project?.id ?? null) as Id<'hostedProjects'> | null}
        projectName={name}
        feed={feed}
        feedError={feedError}
        feedReadAt={lastLine.at}
        viewerHandle={controls.viewerHandle}
        needsRead={needsLive}
      />
      {overlays((project?.id ?? null) as Id<'hostedProjects'> | null)}
    </ProjectFrame>
  );
}
