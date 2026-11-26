// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Landing and checks > Secrets (Item 41a0df87, slice 4): names, what to rotate, proposals and holders. The
// page is value-free and changes nothing: it makes one one-shot names-only read (sealedSecrets:overview) when it
// opens, again on Refresh or Retry and once per "Show the next" page. The Checks hint takes one source names
// projection from the accepted State per refresh. No subscription, no timer, no idle cost or secret values.
import { useConvex } from 'convex/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { missingChecksNames } from '../../../../src/secret-names';
import { Key, Region } from '../../ds';
import { A } from '../frames';
import { crumbsFor, Head } from '../Place';
import { hrefFor } from '../paths';
import { errorCode } from '../session';
import type { PlaceProps, ProjectRoute } from '../screen-route';
import { SecretsHolders } from './SecretsHolders';
import { SecretsNames } from './SecretsNames';
import { SecretsNeeds } from './SecretsNeeds';
import {
  LIST_COMMAND,
  accessDenied,
  appendPage,
  clock,
  exact,
  listOutput,
  sentence,
  type Overview,
  type SecretsView,
  type SetKind,
} from './secrets-model';
import './secrets.css';

/** Still bars appear only after this long: a fast read draws nothing, never a flash. */
const SKELETON_AFTER_MS = 300;

function Loading() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), SKELETON_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  return (
    <Region title="Names">
      <div className="secret-sk" role="status" aria-busy="true">
        <span className="sr">Loading names.</span>
        {[60, 45, 70, 50, 65, 40].map((w, i) => (
          <div className="skrow" key={i} style={{ ['--w' as string]: w }}>
            <div className="sk" />
            <div className="sk" />
          </div>
        ))}
      </div>
    </Region>
  );
}

export function SecretsScreen({
  route,
  projectName,
  view,
  refreshing = false,
  busy = false,
  missingChecks = [],
  onRefresh,
  onMore,
}: {
  route: ProjectRoute;
  projectName: string;
  view: SecretsView;
  /** A read started by Refresh or Retry is out: the rows stay on screen and are replaced when it arrives. */
  refreshing?: boolean;
  /** A page read ("Show the next") is out. */
  busy?: boolean;
  missingChecks?: readonly string[];
  onRefresh?: () => void;
  onMore?: (kind: SetKind, part: 'names' | 'people' | 'rotate') => void;
}) {
  const [cli, setCli] = useState(false);
  const data: Overview | undefined =
    view.status === 'ready' ? view.data : view.status === 'failed' ? view.previous : undefined;
  const trail = crumbsFor(route, projectName);
  const parent = trail.pop()!;
  trail.push(
    { label: 'Landing and checks', href: hrefFor({ ...route, section: 'checks', rest: '' }) },
    parent,
  );
  const now = view.status === 'ready' ? view.shownAt : (view.status === 'failed' ? view.lastShown : 0) || 0;
  const words =
    view.status === 'loading'
      ? { lead: 'Loading secrets…', rest: '' }
      : view.status === 'reader'
        ? { lead: 'Secrets are for people who can write.', rest: '' }
        : view.status === 'failed'
          ? { lead: 'Secrets could not be loaded.', rest: ' Nothing was changed.' }
          : sentence(view.data, missingChecks.length > 0);
  const stamp =
    view.status === 'ready' ? view.shownAt : view.status === 'failed' ? view.lastShown : undefined;
  const head: ReactNode =
    view.status === 'ready' ? (
      <>
        <span className="secret-asof" title={exact(view.shownAt)}>
          shown at {clock(view.shownAt)}
        </span>
        <Key size="sm" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Key>
        <Key
          className="cli"
          aria-controls="secrets-cli"
          aria-expanded={cli}
          onClick={() => setCli(open => !open)}
        >
          <span className="mono">{LIST_COMMAND}</span>
        </Key>
      </>
    ) : null;
  return (
    <div className="secrets-screen">
      <Head
        trail={trail}
        sentence={
          <>
            <b>{words.lead}</b>
            {words.rest}
          </>
        }
      >
        {head}
      </Head>
      {cli && view.status === 'ready' ? (
        <pre className="cli-out mono" id="secrets-cli">
          {listOutput(view.data)}
        </pre>
      ) : null}
      {view.status === 'loading' ? <Loading /> : null}
      {view.status === 'reader' ? (
        <>
          <p className="quietline">Names, holders and proposals are shown to the owner and write members.</p>
          <p className="quietline">
            <A className="lk" href={hrefFor({ ...route, section: '', rest: '' })}>
              People and access
            </A>
          </p>
        </>
      ) : null}
      {view.status === 'failed' ? (
        <div className="notice" data-st="failed" role="alert">
          <span className="st" data-st="failed">
            Could not load
          </span>
          <p>
            {data
              ? `Below is what this page last showed${stamp ? `, at ${clock(stamp)}` : ''}.`
              : 'No secret names were returned.'}
          </p>
          {onRefresh ? (
            <Key size="sm" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? 'Retrying…' : 'Retry'}
            </Key>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <div className="secret-frame">
          <div className="secret-main">
            <SecretsNeeds data={data} now={now} busy={busy} onMore={(kind, part) => onMore?.(kind, part)} />
            <SecretsNames
              data={data}
              now={now}
              busy={busy}
              missingChecks={missingChecks}
              onMore={(kind, part) => onMore?.(kind, part)}
            />
          </div>
          <div className="secret-side">
            <SecretsHolders data={data} now={now} busy={busy} onMore={(kind, part) => onMore?.(kind, part)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

const denied = (error: unknown) => accessDenied(errorCode(error));

/** The page's one read and its pages. `convex.query` is one-shot: nothing subscribes to a set row, so a write by
 * anyone costs this page nothing, and there is no timer. Every read (open, Refresh, Retry) starts a new generation;
 * a reply from an older one is dropped, and a "Show the next" page is applied only to the snapshot that asked for it. */
export default function Secrets({ route, projectId, projectName, feed }: PlaceProps) {
  const convex = useConvex();
  const [view, setView] = useState<SecretsView>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missingChecks, setMissingChecks] = useState<string[]>([]);
  const current = useRef<Id<'hostedProjects'> | null>(null);
  const generation = useRef(0);
  const readyGeneration = useRef(0);
  const exampleRead = useRef(0);
  const read = useCallback(
    async (id: Id<'hostedProjects'>, previous?: Overview) => {
      const mine = ++generation.current;
      setBusy(false);
      setMissingChecks([]);
      const live = () => current.current === id && generation.current === mine;
      try {
        const result = await convex.query(api.sealedSecrets.overview, { projectId: id });
        if (!live()) return;
        readyGeneration.current = mine;
        setView(
          result.status === 'reader'
            ? { status: 'reader' }
            : { status: 'ready', data: result, shownAt: Date.now() },
        );
      } catch (error) {
        if (!live()) return;
        setView(
          previous && !denied(error)
            ? { status: 'failed', previous, lastShown: Date.now() }
            : { status: 'failed' },
        );
      } finally {
        if (live()) setRefreshing(false);
      }
    },
    [convex],
  );
  useEffect(() => {
    current.current = projectId;
    generation.current++;
    setView({ status: 'loading' });
    setBusy(false);
    setRefreshing(false);
    setMissingChecks([]);
    if (projectId) void read(projectId);
    return () => {
      current.current = null;
    };
  }, [projectId, read]);
  const state = feed === undefined ? undefined : (feed.main?.head ?? null);
  // Wait for the project's existing main head. A later line update alone never repeats this read.
  useEffect(() => {
    if (
      !projectId ||
      state === undefined ||
      view.status !== 'ready' ||
      readyGeneration.current !== generation.current ||
      exampleRead.current === generation.current
    )
      return;
    const mine = (exampleRead.current = generation.current);
    const checks = view.data.sets.find(set => set.kind === 2);
    if (!state || !checks?.names || (checks.names.next && !checks.checksNamesAfterPage)) return;
    const present = [...checks.names.page.map(row => row.name), ...(checks.checksNamesAfterPage ?? [])];
    void convex
      .action(api.projectCodeBrowse.read, { projectId, state, want: 'secret-example-names' })
      .then(text => {
        if (current.current !== projectId || generation.current !== mine) return;
        const reply = JSON.parse(text) as { names?: string[] };
        if (reply.names) setMissingChecks(missingChecksNames(reply.names, present));
      })
      .catch(() => undefined);
  }, [convex, projectId, state, view]);
  const shown = view.status === 'ready' ? view.data : view.status === 'failed' ? view.previous : undefined;
  const lastAt =
    view.status === 'ready' ? view.shownAt : view.status === 'failed' ? view.lastShown : undefined;
  const onRefresh = () => {
    if (!projectId) return;
    setRefreshing(true);
    void read(projectId, shown).then(() => undefined);
  };
  const onMore = async (kind: SetKind, part: 'names' | 'people' | 'rotate') => {
    if (!projectId || view.status !== 'ready') return;
    const snapshot = view.data.sets.find(s => s.kind === kind);
    const set = snapshot?.[part];
    if (!snapshot || !set?.next) return;
    const mine = generation.current;
    const live = () => current.current === projectId && generation.current === mine;
    setBusy(true);
    try {
      const result = await convex.query(api.sealedSecrets.overview, {
        projectId,
        kind,
        part,
        after: set.next,
      });
      if (!live()) return;
      const next = appendPage(view.data, kind, part, result);
      if (next.to === 'reader') setView({ status: 'reader' });
      else if (next.to === 'ready') setView({ status: 'ready', data: next.data, shownAt: view.shownAt });
      else {
        setRefreshing(true);
        void read(projectId, view.data);
      }
    } catch (error) {
      if (!live()) return;
      setView(
        denied(error)
          ? { status: 'failed' }
          : { status: 'failed', previous: view.data, lastShown: lastAt ?? Date.now() },
      );
    } finally {
      if (live()) setBusy(false);
    }
  };
  return (
    <SecretsScreen
      route={route}
      projectName={projectName}
      view={view}
      refreshing={refreshing}
      busy={busy}
      missingChecks={missingChecks}
      onRefresh={onRefresh}
      onMore={(kind, part) => void onMore(kind, part)}
    />
  );
}
