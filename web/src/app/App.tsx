// SPDX-License-Identifier: Apache-2.0
// The rebuilt app (Item 84125787): the four frames under ROOT, signed in with Convex Auth. The Convex client sleeps
// with the tab (live-reads.ts) and holds token refresh while asleep (auth-hold.ts), so an idle or hidden tab makes no
// calls. Each page sends one bounded read for its frame: the project frame resolves its address and then reads the
// line; the account and public frames read only the viewer.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react';
import { ConvexReactClient, useConvex, useConvexAuth, useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { prefetchLayerWhenIdle } from '../ds';
import { takeLinkCode } from '../device/link-code';
import { captureConvexFailures } from '../error-capture';
import { liveReads } from '../live-reads';
import { useLiveLine } from '../shell/use-live-line';
import { withRefreshHold } from './auth-hold';
import { Device } from './Device';
import { AccountFrame, BareFrame, ProjectFrame, PublicFrame, type FrameControls } from './frames';
import { Keys, useFrameKeys, type Go } from './keys';
import { hrefFor, parseAppPath, type AppRoute } from './paths';
import { Head } from './Place';
import { AccountScreen, PlaceScreen } from './screens';
import { followLink, navigate, useRoute, useSearch } from './router';
import { forget, recall, safeNext } from './session';
import { FirstPasskey, SignIn } from './SignIn';
import './app.css';
const Legal = lazy(() => import('./Legal'));
const loadingPlace = (
  <p className="quietline" aria-busy="true">
    Loading…
  </p>
);

// Explore, profiles and a public project's front page for visitors: one chunk, loaded with its route (Item 8947a779).
const Discover = lazy(() => import('../public/Discover'));

// Rebuilt places load with their route, never in the first paint.
const Start = lazy(() => import('./start/Start'));

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
const signInHref = (next: string) =>
  `${hrefFor({ frame: 'public', page: 'signin' })}?next=${encodeURIComponent(next)}`;

function Pages() {
  const route = useRoute();
  const search = useSearch();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.urlAccounts.current, isAuthenticated ? {} : 'skip');
  // Anyone can browse signed out: explore, profiles and a project's front page (owner decision 2026-11-16).
  const discovering =
    route.frame === 'discover' ||
    (route.frame === 'project' &&
      !isAuthenticated &&
      route.place === 'needs' &&
      !route.section &&
      !route.rest);
  const needsSignIn =
    !isLoading &&
    !isAuthenticated &&
    !discovering &&
    !(route.frame === 'public' && ['signin', 'terms', 'privacy'].includes(route.page));
  useEffect(() => {
    if (needsSignIn) navigate(signInHref(location.pathname + location.search), { replace: true });
  }, [needsSignIn]);
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
    if (route.page === 'signin')
      return isAuthenticated && search.get('link') !== 'existing' ? <AfterSignIn /> : <SignIn />;
    if (route.page === 'passkey') return <FirstPasskey onDone={finishPasskeyStep} />;
    return <Device viewerHandle={viewer?.handle} />;
  }
  return <SignedIn route={route} viewerHandle={viewer?.handle} />;
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

let lastProject: { href: string; name: string } | null = null;

function SignedIn({
  route,
  viewerHandle,
}: {
  route: Exclude<AppRoute, { frame: 'public' }>;
  viewerHandle: string | undefined;
}) {
  const { signOut } = useAuthActions();
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const leave = () =>
    void signOut().then(() => navigate(hrefFor({ frame: 'public', page: 'signin' }), { replace: true }));
  const go: Go = {
    route,
    openPalette: () => setPalette(true),
    openKeys: () => setKeys(true),
    signOut: leave,
  };
  useFrameKeys(go);
  const controls: FrameControls = { onPalette: go.openPalette, onKeys: go.openKeys, viewerHandle };
  const overlays = <Keys go={go} palette={palette} setPalette={setPalette} keys={keys} setKeys={setKeys} />;
  if (route.frame === 'project') return <ProjectView route={route} controls={controls} overlays={overlays} />;
  if (route.frame === 'account')
    return (
      <AccountFrame place={route.place} back={lastProject} controls={controls}>
        <AccountScreen place={route.place} handle={viewerHandle} leave={leave} />
        {overlays}
      </AccountFrame>
    );
  if (route.frame === 'bare')
    return (
      <BareFrame controls={controls}>
        <Suspense fallback={null}>
          <Start />
        </Suspense>
        {overlays}
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
      {overlays}
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
  overlays: React.ReactNode;
}) {
  const client = useConvex();
  const project = useQuery(api.urlProjects.resolve, { handle: route.handle, slug: route.project });
  const feed = useLiveLine((project?.id ?? null) as Id<'hostedProjects'> | null);
  const [picker, setPicker] = useState<readonly PickerEntry[] | null>(null);
  const asked = useRef(false);
  const name = project?.name ?? route.project;
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
        {overlays}
      </BareFrame>
    );
  return (
    <ProjectFrame
      route={route}
      name={name}
      feed={feed}
      projects={picker}
      controls={{ ...controls, onPicker }}
    >
      <PlaceScreen
        route={route}
        projectId={(project?.id ?? null) as Id<'hostedProjects'> | null}
        projectName={name}
        feed={feed}
        viewerHandle={controls.viewerHandle}
      />
      {overlays}
    </ProjectFrame>
  );
}
