import { useInventory } from './useInventory';
import { usePageCritical } from './ui/page-critical';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConvex, usePaginatedQuery, useQuery } from 'convex/react';
import { useUser } from '@clerk/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
  PortfolioBoundary,
  ReaderDiscoveryBoundary,
  PortfolioData,
  usePortfolioProjects,
  type ProjectSummary,
} from './ProjectHomeData';
import { projectWorkLink } from './portfolio-work';
import { hostedError } from './snapshot';
import { Button, Panel } from './ui/primitives';
import './project-home.css';
import { HomeProjectRow } from './HomeProjectRow';
import { HomeSourceRows } from './HomeSourceRows';
type Props = {
  choose: (id: Id<'hostedProjects'>) => void;
  create: () => void;
  upload: () => void;
  explore?: () => void;
  openImport?: (id: Id<'imports'>) => void;
};
type Import = FunctionReturnType<typeof api.sharingActions.list>['page'][number];
export default function ProjectHome(props: Props) {
  return (
    <ReaderDiscoveryBoundary>
      {available => <ProjectList {...props} discoverReaders={available} />}
    </ReaderDiscoveryBoundary>
  );
}
function ProjectList({
  choose,
  create,
  upload,
  explore,
  openImport,
  discoverReaders,
}: Props & { discoverReaders: boolean }) {
  const { projects, loading, more, loadMore } = usePortfolioProjects(discoverReaders);
  const imports = usePaginatedQuery(api.importRemoval.listMine, {}, { initialNumItems: 20 });
  const saved = useInventory(api.savedViews.list, 'savedViews', {}, 50);
  const client = useConvex();
  const pendingStars = useRef(new Map<string, FunctionArgs<typeof api.savedViewActions.save>>());
  const { user } = useUser();
  const starsKey = `forge.project-stars.${user?.id ?? ''}`;
  const [projectStars, setProjectStars] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(starsKey) ?? '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggleProjectStar = (id: string) => {
    const next = projectStars.includes(id)
      ? projectStars.filter(value => value !== id)
      : [...projectStars, id];
    try {
      localStorage.setItem(starsKey, JSON.stringify(next));
      setProjectStars(next);
    } catch {
      setError('Could not save this star in your browser.');
    }
  };

  const [shared, setShared] = useState<{ page: Import[]; isDone: boolean; continueCursor: string } | null>(
      null,
    ),
    [error, setError] = useState('');
  const [filter, setFilter] = useState(
      () =>
        ({ saved: 'starred', repositories: 'github', shared: 'shared' })[
          new URLSearchParams(location.search).get('collection') ?? ''
        ] ?? 'all',
    ),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState('');
  const [zones, setZones] = useState<FunctionReturnType<typeof api.zoneActions.shared> | null>(null);
  const zonesLoading = useRef(false);
  const sharedLoading = useRef(false);
  const loadZones = useCallback(
    async (cursor: string | null = null) => {
      if (zonesLoading.current) return;
      zonesLoading.current = true;
      try {
        const next = await client.action(api.zoneActions.shared, {
          paginationOpts: { numItems: 20, cursor },
        });
        setZones(previous => ({
          ...next,
          page: cursor && previous ? [...previous.page, ...next.page] : next.page,
        }));
      } catch (e) {
        setError(hostedError(e));
      } finally {
        zonesLoading.current = false;
      }
    },
    [client],
  );
  useEffect(() => {
    void loadZones();
  }, [loadZones]);
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary>>({});
  const update = useCallback(
    (id: string, value: ProjectSummary) => setSummaries(previous => ({ ...previous, [id]: value })),
    [],
  );
  const loadShared = useCallback(
    async (cursor: string | null = null) => {
      if (sharedLoading.current) return;
      sharedLoading.current = true;
      try {
        const next = await client.action(api.sharingActions.list, {
          paginationOpts: { numItems: 20, cursor },
        });
        setShared(previous => ({
          ...next,
          page: cursor && previous ? [...previous.page, ...next.page] : next.page,
        }));
      } catch (e) {
        setError(hostedError(e));
      } finally {
        sharedLoading.current = false;
      }
    },
    [client],
  );
  useEffect(() => {
    void loadShared();
  }, [loadShared]);
  const unavailable = useQuery(api.importRemoval.removed, {
    ids: [...(shared?.page ?? []).map(row => row.id), ...(zones?.page ?? []).map(row => row.importId)],
  });
  const rows = [
    ...new Map(
      [
        ...imports.results.map(item => ({ ...item, shared: false })),
        ...(shared?.page ?? [])
          .filter(row => !unavailable?.includes(row.id))
          .map(item => ({ ...item, shared: true })),
      ].map(item => [item.id, item]),
    ).values(),
  ];
  const bookmarks = saved.results;
  const projectRows = (loading ? [] : projects)
    .filter(
      p =>
        (['all', p.shared ? 'shared' : 'yours'].includes(filter) ||
          (filter === 'starred' && projectStars.includes(p.id))) &&
        p.name.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(projectStars.includes(b.id)) - Number(projectStars.includes(a.id)) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  const importRows = rows.filter(
    row =>
      (filter === 'all' ||
        filter === 'github' ||
        filter === (row.shared ? 'shared' : 'yours') ||
        (filter === 'starred' && bookmarks.some(item => item.importId === row.id))) &&
      row.repository.toLowerCase().includes(query.toLowerCase()),
  );
  // A saved source location can outlive the current page of imported projects. Keep it reachable.
  const savedOnly = bookmarks.filter(item => !rows.some(row => row.id === item.importId));
  const attention = Object.values(summaries).reduce((n, s) => n + s.attention.length, 0);
  const pending =
    loading ||
    imports.status === 'LoadingFirstPage' ||
    saved.status === 'LoadingFirstPage' ||
    ((!shared || !zones) && !error);
  const zoneRows = (zones?.page ?? []).filter(
    zone =>
      !unavailable?.includes(zone.importId) &&
      ['all', 'shared', 'github'].includes(filter) &&
      `${zone.name} ${zone.repository}`.toLowerCase().includes(query.toLowerCase()),
  );
  usePageCritical('Projects', {
    projects: !loading,
    imports: imports.status !== 'LoadingFirstPage',
    saved: saved.status !== 'LoadingFirstPage',
    shared: !!shared || !!error,
    zones: !!zones || !!error,
    summaries:
      !loading &&
      projects.every(project => !!summaries[project.id] && !summaries[project.id]!.initialLoading),
  });
  const empty = !pending && !projects.length && !rows.length && !savedOnly.length && !zones?.page.length;
  const recent = projects
    .flatMap(project => (summaries[project.id]?.recent ?? []).map(item => ({ ...item, project })))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? b.at ?? ''))
    .slice(0, 5);
  async function star(id: Id<'imports'>, name: string) {
    setBusy(id);
    setError('');
    try {
      let command = pendingStars.current.get(id);
      if (!command) {
        const status = JSON.parse(await client.action(api.hosted.read, { id, endpoint: 'status' })) as {
          sourceId: string;
        };
        command = {
          operationId: crypto.randomUUID(),
          importId: id,
          name,
          route: { view: 'home', file: '', line: 1, state: status.sourceId },
        };
        pendingStars.current.set(id, command);
      }
      await client.action(api.savedViewActions.save, command);
      pendingStars.current.delete(id);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy('');
    }
  }
  const open = (id: Id<'imports'>) => {
    if (openImport) openImport(id);
    else {
      const url = new URL('/', location.href);
      url.searchParams.set('codescape', id);
      location.assign(url);
    }
  };
  return (
    <div className="fx fx-projects-home">
      {projects.map(project => (
        <PortfolioBoundary key={project.id} fallback={null}>
          <PortfolioData project={project} onChange={update} />
        </PortfolioBoundary>
      ))}
      <header className="fx-home-head">
        <div>
          <h1>Projects</h1>
          <p>
            {attention > 0
              ? `${attention} need you across your projects`
              : empty
                ? 'No projects yet.'
                : '\u00a0'}
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={create}>
          New project
        </Button>
      </header>
      {error && <ErrorToast>{error}</ErrorToast>}
      {empty ? (
        <div className="fx-home-empty">
          {explore && (
            <Button title="Read-only code analysis; no editable project is created." onClick={explore}>
              Import from GitHub
            </Button>
          )}
          <Button onClick={upload}>Upload existing project</Button>
        </div>
      ) : (
        <div className="fx-home-grid">
          <Panel title="Your projects" count={projects.length + rows.length}>
            <div className="fx-home-filters" role="group" aria-label="Filter projects">
              {[
                ['all', 'All'],
                ['yours', 'Yours'],
                ['shared', 'Shared with you'],
                ['starred', '★ Starred'],
                ['github', 'GitHub'],
              ].map(([id, label]) => (
                <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id!)}>
                  {label}
                </button>
              ))}
              <input
                type="search"
                aria-label="Find a project"
                placeholder="Find a project"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
            <div className="fx-home-columns">
              <span>Project · main</span>
              <span>Who’s working</span>
              <span>Needs you</span>
            </div>
            {loading && (
              <div role="status" aria-label="Loading projects" aria-busy="true">
                {Array.from({ length: Math.max(projects.length + rows.length, 1) }, (_, index) => (
                  <div className="fx-home-row" key={index}>
                    <div>
                      <span className="fx-muted">Loading project…</span>
                      <div className="fx-home-fact">main</div>
                    </div>
                    <span className="fx-muted">—</span>
                    <span className="fx-muted">—</span>
                  </div>
                ))}
              </div>
            )}
            {projectRows.map(project => (
              <PortfolioBoundary
                key={project.id}
                fallback={<ErrorToast read error={`Could not load Work for ${project.name}.`} />}
              >
                <HomeProjectRow
                  project={project}
                  summary={summaries[project.id]}
                  starred={projectStars.includes(project.id)}
                  toggleStar={() => toggleProjectStar(project.id)}
                  choose={() => choose(project.id)}
                />
              </PortfolioBoundary>
            ))}
            {!pending && (
              <HomeSourceRows
                imports={importRows}
                bookmarks={bookmarks}
                zones={zoneRows}
                savedOnly={savedOnly}
                filter={filter}
                busy={busy}
                open={open}
                star={star}
                unstar={(id, stars) => {
                  setBusy(id);
                  void Promise.all(stars.map(item => client.mutation(api.savedViews.remove, { id: item.id })))
                    .catch(e => setError(hostedError(e)))
                    .finally(() => setBusy(''));
                }}
              />
            )}
            {!pending &&
              !projectRows.length &&
              !importRows.length &&
              !zoneRows.length &&
              (!['all', 'starred'].includes(filter) || !savedOnly.length) && (
                <p className="fx-home-loading">No matching projects.</p>
              )}
            {(more ||
              imports.status === 'CanLoadMore' ||
              saved.status === 'CanLoadMore' ||
              (shared && !shared.isDone) ||
              (zones && !zones.isDone)) && (
              <div className="fx-home-more">
                <Button
                  onClick={() => {
                    loadMore();
                    if (imports.status === 'CanLoadMore') imports.loadMore(20);
                    if (saved.status === 'CanLoadMore') saved.loadMore(50);
                    if (shared && !shared.isDone) void loadShared(shared.continueCursor);
                    if (zones && !zones.isDone) void loadZones(zones.continueCursor);
                  }}
                >
                  Load more
                </Button>
              </div>
            )}
          </Panel>
          <aside>
            {recent.length > 0 && (
              <Panel title="Recent across projects">
                {recent.map(item => (
                  <a
                    key={`${item.project.id}:${item.id}`}
                    className="fx-home-recent"
                    href={projectWorkLink(item.project.id, item)}
                  >
                    <b>{item.title}</b>
                    <span>
                      {item.project.name} · {item.status}
                    </span>
                  </a>
                ))}
              </Panel>
            )}
            <Panel title="Add a project">
              <div className="fx-home-way">
                <b>Host a folder from your machine</b>
                <code>nforge host .</code>
              </div>
              {explore && (
                <div className="fx-home-way">
                  <b title="Read-only code analysis; no editable Forge project is created.">
                    Import from GitHub · read-only analysis
                  </b>
                  <Button onClick={explore}>Choose a repository</Button>
                </div>
              )}
              <div className="fx-home-way">
                <Button onClick={upload}>Upload existing project</Button>
              </div>
            </Panel>
          </aside>
        </div>
      )}
    </div>
  );
}
