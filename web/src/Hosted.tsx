import { countLabel } from './ui/count';
import { ReadableRoute } from './shell/ReadableRoute';
import { AccountHandle } from './settings/AccountHandle';
import { useReadRetry } from './ui/read-retry';
import { ErrorToast } from './ui/Toast';
import { routeSearch } from './shell/location';
// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import './legacy-hosted.css';
import { ClerkProvider, SignInButton, SignOutButton, useAuth, useUser, useClerk } from '@clerk/react';
import { ConvexProvider, ConvexReactClient, useConvex, useConvexAuth } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';

/** Convex auth always uses the Clerk `convex` JWT template (10 min lifetime). Clerk's own session token
 * lives 60 s, and each refresh makes the server re-run every live query of the tab. */
function useConvexTokenAuth() {
  const auth = useAuth();
  const { getToken } = auth;
  const convexToken = useCallback(
    (options?: Parameters<typeof getToken>[0]) => getToken({ ...options, template: 'convex' }),
    [getToken],
  );
  return { ...auth, getToken: convexToken } as typeof auth;
}
import { api as functions } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { SourceRequest, Route } from './api';
import { watchImport } from './import-watch';
import { PointField } from './PointField';
import { ActionPanel, Icon, PageTabs, LazyPage, useDestination, useSection } from './WorkspaceUI';
import { hostedError as message, hostedFailure, snapshotDownload } from './snapshot';
import ImportedSourceSettings from './settings/ImportedSourceSettings';
import { SaveView } from './SavedViews';
import Teams from './Teams';
import Secrets from './Secrets';
import { InterestControls } from './Interests';
import PublicImports from './PublicImports';
import UpstreamRequest from './UpstreamRequest';
import ProjectBackups from './ProjectBackups';
import AccountData from './AccountData';
import DeviceLogin, { DeviceCredentials } from './DeviceLogin';
import { HostedFrame } from './shell/HostedFrame';
import { DryRun } from './landing/DryRun';
import { Importing, Landing } from './landing/Landing';
import { AppLoader } from './ui/AppLoader';
import { captureConvexFailures, errorReporter } from './error-capture';
import { liveReads } from './live-reads';
import { Button } from './ui/primitives';

const App = lazy(() => import('./App'));

type Job = {
  opened?: boolean;
  repository: string;
  ref: string;
  visibility: string;
  phase: string;
  processed: number;
  total: number;
  error?: string;
  canRefresh: boolean;
  zone?: { id: string; name: string; head: string };
};
const initialId = () => new URLSearchParams(routeSearch()).get('codescape') as Id<'imports'> | null;
const initialZone = () => new URLSearchParams(routeSearch()).get('zone') as Id<'sourceZones'> | null;

/** Sign-in in the cockpit button style (Clerk opens its own modal). */
function SignIn() {
  return (
    <SignInButton mode="modal">
      <Button variant="secondary">Sign in</Button>
    </SignInButton>
  );
}
function Account() {
  const { isSignedIn } = useUser();
  return isSignedIn ? (
    <SignOutButton>
      <button type="button" className="fx-account-signout">
        Sign out
      </button>
    </SignOutButton>
  ) : (
    <SignInButton mode="modal">
      <button>Sign in</button>
    </SignInButton>
  );
}
type Surface = 'projects' | 'explore' | 'agents' | 'account' | 'contact';
export function Explorer({
  identity,
  signedIn = false,
  initialSurface = 'explore',
}: {
  identity: boolean;
  signedIn?: boolean;
  initialSurface?: Surface;
}) {
  const readAttempt = useReadRetry();
  const client = useConvex();
  const [id, setId] = useState(initialId),
    [zone, setZone] = useState(initialZone);
  const [surface, setSurface] = useSection(
    'surface',
    ['projects', 'explore', 'agents', 'account', 'contact'] as const,
    initialId() ? 'explore' : initialSurface,
  );
  const [attempt, setAttempt] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const sourceReady = job?.phase === 'ready' || job?.opened === true;
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tour, setTour] = useState(() => new URLSearchParams(routeSearch()).get('tour') === '1');
  useEffect(() => {
    const pop = () => {
      setTour(new URLSearchParams(routeSearch()).get('tour') === '1');
      setId(initialId());
      setZone(initialZone());
      setJob(null);
      setError('');
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (!id) return;
    let active = true,
      loading = false,
      pending = false;
    const load = async () => {
      if (loading) {
        pending = true;
        return;
      }
      loading = true;
      try {
        const next = JSON.parse(
          await (zone
            ? client.action(functions.zoneActions.status, { id: zone, importId: id })
            : client.action(functions.hosted.status, { id })),
        ) as Job;
        if (active) {
          // Retain the mounted explorer during a re-index of an opened source.
          // Its completion subscription owns the new-state navigation.
          setJob(previous => ({
            ...next,
            opened: previous?.opened || previous?.phase === 'ready' || next.phase === 'ready',
          }));
          setError(next.error ?? '');
        }
      } catch (e) {
        if (active) setError(message(e));
      } finally {
        loading = false;
        if (pending && active) {
          pending = false;
          void load();
        }
      }
    };
    const unsubscribe = watchImport(client, id, () => void load(), zone);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, id, zone, attempt, readAttempt]);
  const subscribeStatus = useCallback(
    (refresh: () => void) => {
      if (!id) return () => {};
      return watchImport(client, id, refresh, zone);
    },
    [client, id, zone],
  );
  const request = useCallback<SourceRequest>(
    async <T,>(endpoint: string, signal?: AbortSignal): Promise<T> => {
      if (!id) throw new Error('Choose a repository.');
      if (endpoint === 'reindex') {
        if (zone) throw new Error('This source Zone stays pinned to its selected snapshot.');
        const refreshed = await client.action(functions.hosted.refresh, { id });
        return new Promise<T>((resolve, reject) => {
          let unsubscribe: () => void = () => undefined;
          let loading = false,
            pending = false,
            stopped = false;
          const stop = () => {
            stopped = true;
            unsubscribe?.();
            signal?.removeEventListener('abort', abort);
          };
          const abort = () => {
            stop();
            reject(new DOMException('Request cancelled', 'AbortError'));
          };
          const load = async () => {
            if (stopped) return;
            if (loading) {
              pending = true;
              return;
            }
            loading = true;
            try {
              const progress = JSON.parse(
                await client.action(functions.hosted.status, { id: refreshed }),
              ) as Job;
              if (stopped) return;
              if (progress.phase === 'error') throw new Error(progress.error ?? 'Import failed.');
              if (progress.phase === 'ready') {
                stop();
                resolve(null as T);
              }
            } catch (error) {
              if (!stopped) {
                stop();
                reject(error);
              }
            } finally {
              loading = false;
              if (pending && !stopped) {
                pending = false;
                void load();
              }
            }
          };
          unsubscribe = watchImport(client, refreshed, () => void load());
          if (stopped) unsubscribe();
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      let result: string;
      try {
        result = await (zone
          ? client.action(functions.zoneActions.read, { id: zone, endpoint })
          : client.action(functions.hosted.read, { id, endpoint }));
      } catch (error) {
        throw hostedFailure(error);
      }
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      return JSON.parse(result) as T;
    },
    [client, id, zone],
  );
  const open = async (repository: string, revision = ref) => {
    setSurface('explore');
    setBusy(true);
    setError('');
    try {
      const next = await client.action(functions.hosted.start, {
        url: repository,
        ...(revision.trim() ? { ref: revision.trim() } : {}),
      });
      history.pushState(null, '', `?codescape=${next}&tour=1`);
      setTour(true);
      setJob(null);
      setId(next);
      setZone(null);
      setAttempt(value => value + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const back = () => {
    history.pushState(null, '', location.pathname);
    setId(null);
    setZone(null);
    setJob(null);
    setError('');
  };
  const download = async () => {
    if (!id) return;
    const { blob, filename } = await snapshotDownload(async (offset, digest) => {
      try {
        return await (zone
          ? client.action(functions.zoneActions.downloadPart, {
              id: zone,
              offset,
              ...(digest ? { digest } : {}),
            })
          : client.action(functions.lifecycleActions.downloadPart, {
              id,
              offset,
              ...(digest ? { digest } : {}),
            }));
      } catch (e) {
        throw new Error(message(e));
      }
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = zone ? filename.replace('.forge.json', `-zone-${zone}.forge.json`) : filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const signIn = identity && !signedIn ? <SignIn /> : undefined;
  if (id && job?.phase === 'ready' && tour && !zone)
    return (
      <HostedFrame identity={signedIn} surface="explore" setSurface={setSurface} account={signIn}>
        <div className="fx">
          <DryRun
            request={request}
            repository={job.repository}
            back={back}
            openCode={() => {
              history.pushState(null, '', `?codescape=${id}`);
              setTour(false);
            }}
          />
        </div>
      </HostedFrame>
    );
  if (surface === 'explore' && (id ? !sourceReady : !signedIn))
    return (
      <HostedFrame identity={signedIn} surface="explore" setSurface={setSurface} account={signIn}>
        <div className="fx">
          {id ? (
            <Importing
              {...(job
                ? { repository: job.repository, phase: job.phase, processed: job.processed, total: job.total }
                : {})}
              {...(error ? { error } : {})}
              {...(job?.phase === 'error' ? { retry: () => void open(job.repository, job.ref) } : {})}
              back={back}
            />
          ) : (
            <Landing
              open={repository => void open(repository, '')}
              busy={busy}
              error={error}
              {...(import.meta.env.VITE_FORGE_DEMO_REPOSITORY
                ? { demo: import.meta.env.VITE_FORGE_DEMO_REPOSITORY as string }
                : {})}
              more={
                <div className="fx-legacy fx-landing-recent">
                  <PublicImports />
                </div>
              }
            />
          )}
        </div>
      </HostedFrame>
    );
  if (id && job && sourceReady)
    return (
      <HostedFrame
        identity={signedIn}
        surface="explore"
        setSurface={next => {
          back();
          setSurface(next);
        }}
        account={identity && <Account />}
      >
        <Suspense fallback={<AppLoader />}>
          <App
            key={`${id}:${zone ?? ''}`}
            hosted={{
              request,
              subscribeStatus,
              back,
              download,
              canRefresh: job.canRefresh,
              zone: job.zone,
              ...(identity && !zone
                ? {
                    saveView: (route: Route) => (
                      <>
                        <InterestControls importId={id} />
                        <SaveView id={id} route={route} />
                      </>
                    ),
                  }
                : {}),
            }}
          />
        </Suspense>
      </HostedFrame>
    );
  const demo = import.meta.env.VITE_FORGE_DEMO_REPOSITORY as string | undefined;
  return (
    <HostedFrame
      identity={signedIn}
      surface={surface}
      setSurface={setSurface}
      account={identity && <Account />}
    >
      <div className="app portal">
        <div className="hosted-home">
          <section
            className="explore-surface"
            hidden={surface !== 'explore'}
            aria-label="Explore repositories"
          >
            {id && <h1>Connecting your source</h1>}
            {id ? (
              <>
                <p>{job ? `${job.repository} · ${job.ref}` : 'Connecting to your repository…'}</p>
                <p role="status">
                  {job
                    ? `${job.phase} · ${job.processed} / ${countLabel(job.total, 'file')}`
                    : 'Loading import status'}
                </p>
                {job && job.total > 0 && <progress value={job.processed} max={job.total} />}
                <button onClick={back}>Repositories</button>
                {job?.phase === 'error' && (
                  <button onClick={() => void open(job.repository, job.ref)}>Retry import</button>
                )}
              </>
            ) : (
              <>
                <div className="arrival">
                  <PointField decorative />
                  <div className="arrival-content">
                    <h1>
                      {identity ? (
                        'Explore repositories'
                      ) : (
                        <>
                          Your code.
                          <br />
                          <span>Connected.</span>
                        </>
                      )}
                    </h1>
                    {!identity && (
                      <p>
                        See the relationships behind your repository. Bring a public GitHub link and start
                        exploring.
                      </p>
                    )}
                    <form
                      onSubmit={e => {
                        e.preventDefault();
                        void open(url);
                      }}
                    >
                      <div className="url-entry">
                        <Icon name="graph" />
                        <label>
                          <span className="sr-only">GitHub repository</span>
                          <input
                            value={url}
                            onChange={e => setUrl(e.target.value)}
                            placeholder="Paste a public GitHub repository URL"
                            required
                          />
                        </label>
                        <button className="primary" disabled={busy}>
                          {busy ? 'Connecting…' : 'Explore repository'} <Icon name="arrow" />
                        </button>
                      </div>
                      <ActionPanel title="Choose a branch or revision">
                        <label>
                          Branch, tag or commit (optional)
                          <input
                            value={ref}
                            onChange={e => setRef(e.target.value)}
                            placeholder="Default branch"
                          />
                        </label>
                      </ActionPanel>
                      {error && <ErrorToast>{error}</ErrorToast>}
                    </form>
                    <div className="arrival-links">
                      {demo && (
                        <button disabled={busy} onClick={() => void open(demo, '')}>
                          Try the public demo <Icon name="arrow" />
                        </button>
                      )}
                      {identity && (
                        <button onClick={() => setSurface('projects')}>
                          Your projects <Icon name="arrow" />
                        </button>
                      )}
                    </div>
                    {!identity && <p className="arrival-note">Public repositories · no account needed</p>}
                  </div>
                </div>
                {identity && (
                  <ActionPanel title="Connect a private GitHub repository">
                    <a
                      href="https://github.com/apps/nanthai-forge-dev/installations/new"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Connect GitHub repositories
                    </a>
                    <p>
                      Sign in with GitHub, select repositories for the Forge GitHub App, then enter their URL
                      above.
                    </p>
                  </ActionPanel>
                )}
                <PublicImports />
              </>
            )}
            {id && error && <ErrorToast>{error}</ErrorToast>}
          </section>
          {identity && (
            <SignedInImports
              surface={surface}
              explore={() => setSurface('explore')}
              open={next => {
                setSurface('explore');
                history.pushState(null, '', `?codescape=${next}`);
                setJob(null);
                setId(next);
                setZone(null);
                setError('');
              }}
            />
          )}
          {surface === 'contact' && (
            <section>
              <h1>Contact Forge</h1>
              <p>Prepare a support or upstream request with the relevant source details.</p>
              <UpstreamRequest />
            </section>
          )}
        </div>
      </div>
    </HostedFrame>
  );
}
function SignedInImports({
  surface,
  explore,
  open,
}: {
  surface: Surface;
  explore: () => void;
  open: (id: Id<'imports'>) => void;
}) {
  const { isSignedIn, user } = useUser();
  const [repositorySettings] = useDestination('repositorySettings');
  // Inside a project the cockpit shell is the whole frame; the collection tabs belong to the list.
  if (!isSignedIn)
    return (
      <section hidden={surface === 'explore'} className="session-surface">
        <h1>{surface === 'projects' ? 'Your projects' : 'Your account'}</h1>
        <p>Sign in to open your private projects, saved views and account tools.</p>
        <Account />
      </section>
    );
  return (
    <>
      <LazyPage active={surface === 'projects'}>
        {repositorySettings ? (
          <ImportedSourceSettings id={repositorySettings as Id<'imports'>} />
        ) : (
          <ProjectBackups key={`projects-${user?.id}`} explore={explore} />
        )}
      </LazyPage>
      <LazyPage active={surface === 'account'}>
        <AccountSettings open={open} userId={user?.id} />
      </LazyPage>
    </>
  );
}
function AccountSettings({ open, userId }: { open: (id: Id<'imports'>) => void; userId?: string }) {
  const { user } = useUser();
  const { openUserProfile } = useClerk();
  const [section, setSection] = useSection(
    'settings',
    ['you', 'sharing', 'secrets', 'account'] as const,
    'you',
  );
  return (
    <>
      <h1>Settings</h1>
      <div className="account-layout">
        <PageTabs
          label="Account settings"
          value={section}
          onChange={setSection}
          items={[
            { id: 'you', label: 'You' },
            { id: 'sharing', label: 'Teams & sharing' },
            { id: 'secrets', label: 'Secret Objects' },
            { id: 'account', label: 'Account & data' },
          ]}
        />
        <div>
          <LazyPage active={section === 'you'}>
            <h2>You</h2>
            <AccountHandle />
          </LazyPage>
          <LazyPage active={section === 'sharing'}>
            <Teams key={`teams-${userId}`} open={open} />
          </LazyPage>
          <LazyPage active={section === 'secrets'}>
            <Secrets key={`secrets-${userId}`} />
          </LazyPage>
          <LazyPage active={section === 'account'}>
            <section className="account-profile">
              <h2>{user?.fullName || user?.username || 'Your account'}</h2>
              <p>{user?.primaryEmailAddress?.emailAddress}</p>
              <Button onClick={() => openUserProfile()}>Manage account</Button>
            </section>
            {userId && (
              <>
                <DeviceCredentials key={`devices-${userId}`} />
                <AccountData key={userId} userId={userId} />
              </>
            )}
          </LazyPage>
        </div>
      </div>
    </>
  );
}
function ConnectedExplorer() {
  const { isLoading, isAuthenticated } = useConvexAuth(),
    { userId, isLoaded } = useAuth(),
    convex = useConvex();
  // Only signed-in accounts report; anonymous failures stay in the browser.
  useEffect(
    () =>
      isAuthenticated
        ? errorReporter.attach(report => convex.mutation(functions.clientErrors.report, report))
        : undefined,
    [convex, isAuthenticated],
  );
  return isLoading || !isLoaded ? (
    <AppLoader />
  ) : isAuthenticated ? (
    <ReadableRoute>
      <Explorer key={userId} identity signedIn initialSurface="projects" />
    </ReadableRoute>
  ) : (
    <Explorer key="anonymous" identity initialSurface="explore" />
  );
}
export default function Hosted() {
  const [client] = useState(() =>
    import.meta.env.VITE_CONVEX_URL
      ? liveReads.client(
          captureConvexFailures(
            new ConvexReactClient(import.meta.env.VITE_CONVEX_URL, { unsavedChangesWarning: false }),
          ),
        )
      : null,
  );
  // Hidden or idle tabs hold no Convex subscriptions; see docs/architecture.md.
  useEffect(() => liveReads.watchActivity(), []);
  if (!client)
    return (
      <main className="hosted-home">
        <h1>Forge backend is not configured</h1>
        <p>Set VITE_CONVEX_URL for this development build.</p>
      </main>
    );
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  return key ? (
    <ClerkProvider publishableKey={key}>
      <ConvexProviderWithClerk client={client} useAuth={useConvexTokenAuth}>
        {location.pathname === '/device' ? <DeviceLogin /> : <ConnectedExplorer />}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  ) : (
    <ConvexProvider client={client}>
      <Explorer identity={false} />
    </ConvexProvider>
  );
}
