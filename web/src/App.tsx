import { routeUrlState } from './shell/location';
import { ErrorToast } from './ui/Toast';
import { useDestination } from './WorkspaceUI';
import { requestNavigation } from './ui/navigation';
// SPDX-License-Identifier: Apache-2.0
import './legacy-app.css';
import './code.css';
import { CodeFileTree } from './CodeFileTree';
import { CodeChanges, type CodeLane } from './CodeChanges';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { endpoint, readRoute, routeUrl, useQuery, type SourceRequest } from './api';
import type {
  FileRecord,
  ImportEdge,
  Page,
  Readme,
  ReferenceEdge,
  Route,
  Source,
  Status,
  SymbolNode,
} from './api';
import UpstreamRequest from './UpstreamRequest';
import { publicRequestSource } from './upstream-request';
import { ReferenceMap } from './Map';
import { Inspector, ReadmeView, SourceView } from './Content';
import { Home } from './Home';
import { Icon, type IconName } from './WorkspaceUI';
import { FileActivity } from './FileActivity';
import type { DocumentTarget } from '../../src/document-paths';

/** Source explorer for imported repositories, rendered inside the hosted shell (which owns brand, theme and navigation). */
export default function App({
  hosted,
}: {
  hosted: {
    lanes?: readonly CodeLane[];
    request: SourceRequest;
    subscribeStatus: (refresh: () => void) => () => void;
    back: () => void;
    download: () => Promise<void>;
    canRefresh?: boolean;
    zone?: { name: string; head: string };
    saveView?: (route: Route) => ReactNode;
  };
}) {
  const request = hosted.request;
  const codeLanes = hosted.lanes ?? [];
  const touched = new Set(codeLanes.flatMap(lane => lane.paths.map(path => path.path)));
  const [route, setRoute] = useState<Route>(() => readRoute(false));
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [reindexError, setReindexError] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState('');
  const [search, setSearch] = useDestination('fileFilter');
  const [offset, setOffset] = useState(0);
  const symbol = route.symbol ?? '';
  const app = useRef<HTMLDivElement>(null);
  const reindexController = useRef<AbortController | null>(null);
  useEffect(() => () => reindexController.current?.abort(), []);
  const pendingFocus = useRef(Boolean(route.anchor));
  const navigate = useCallback(
    (
      change: Partial<Route>,
      focus = true,
      selectLine = change.line !== undefined || routeUrlState().searchParams.has('line'),
    ) => {
      const next = { ...route, ...change };
      if (
        change.view !== undefined ||
        change.file !== undefined ||
        change.line !== undefined ||
        change.lens !== undefined
      ) {
        if (!('anchor' in change)) delete next.anchor;
        if (!('document' in change) && change.view !== undefined) delete next.document;
      }
      if (
        (change.file !== undefined && change.file !== route.file) ||
        (change.state !== undefined && change.state !== route.state)
      ) {
        delete next.symbol;
        delete next.lens;
      }
      if (focus && Object.keys(change).some(key => key !== 'symbol')) pendingFocus.current = true;
      requestNavigation(() => {
        if (Object.keys(change).every(key => ['view', 'lens', 'symbol'].includes(key)))
          history.replaceState(history.state, '', routeUrl(next, selectLine));
        else history.pushState(null, '', routeUrl(next, selectLine));
        setRoute(next);
      });
    },
    [route],
  );
  useEffect(() => {
    const pop = () => {
      pendingFocus.current = true;
      setRoute(readRoute(false));
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = false,
      pending = false;
    const refresh = async () => {
      if (active) {
        pending = true;
        return;
      }
      active = true;
      try {
        const data = await request<Status>('status', controller.signal);
        if (!controller.signal.aborted) {
          setStatus(data);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError((e as Error).message);
          setStatus(null);
        }
      } finally {
        active = false;
        if (pending && !controller.signal.aborted) {
          pending = false;
          void refresh();
        }
      }
    };
    const unsubscribe = hosted.subscribeStatus(() => void refresh());
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [request, hosted.subscribeStatus]);
  useEffect(() => {
    if (status && !route.state) {
      setRoute(previous => {
        const next = { ...previous, state: status.sourceId };
        history.replaceState(null, '', routeUrl(next, routeUrlState().searchParams.has('line')));
        return next;
      });
    }
  }, [status, route.state]);
  const mismatch = Boolean(status && route.state && status.sourceId !== route.state);
  const ready = Boolean(status?.freshness === 'current' && !mismatch && !busy);
  const state = route.state || status?.sourceId || '';
  const files = useQuery<Page<FileRecord>>(
    ready ? endpoint('files', { state, search, offset, limit: 50 }) : null,
    request,
  );
  const matches = useQuery<Page<SymbolNode | ({ kind: 'File' } & FileRecord)>>(
    ready && search ? endpoint('context', { state, search, limit: 30 }) : null,
    request,
  );
  useEffect(() => {
    if (route.view === 'source' && !route.file && files.data?.results[0])
      navigate({ file: files.data.results[0].path }, false);
  }, [files.data, navigate, route.file]);
  const imports = useQuery<Page<ImportEdge>>(
    ready && route.file ? endpoint('imports', { state, file: route.file, limit: 100 }) : null,
    request,
  );
  const incoming = useQuery<Page<ImportEdge>>(
    ready && route.file ? endpoint('impact', { state, file: route.file, limit: 100 }) : null,
    request,
  );
  const declarations = useQuery<Page<SymbolNode>>(
    ready && route.file ? endpoint('declarations', { state, file: route.file, limit: 100 }) : null,
    request,
  );
  const references = useQuery<Page<ReferenceEdge>>(
    ready && symbol ? endpoint('refs', { state, symbol, limit: 50 }) : null,
    request,
  );
  const inlineDeclaration = declarations.data?.results.find(node => node.id === symbol);
  const inspected = useQuery<Page<SymbolNode>>(
    ready && symbol && declarations.data && !inlineDeclaration
      ? endpoint('inspect', { state, symbol, limit: 1 })
      : null,
    request,
  );
  const selectedDeclaration = inlineDeclaration ?? inspected.data?.results[0];
  const source = useQuery<Page<Source>>(
    ready && route.view === 'source' && route.file
      ? endpoint('source', { state, file: route.file, start: route.line, end: route.line + 79 })
      : null,
    request,
  );
  const readme = useQuery<Readme>(
    route.view === 'readme' && ready
      ? endpoint('readme', { state, ...(route.document ? { file: route.document } : {}) })
      : null,
    request,
  );
  const home = useQuery<Readme>(route.view === 'home' && ready ? `home?state=${state}` : null, request);
  const openSource = (file: string, line: number) => navigate({ file, line, view: 'source' });
  const selectFile = (file: string) => navigate({ file, line: 1 }, route.view === 'source', false);
  const documentRoute = (target: DocumentTarget): Partial<Route> =>
    target.source
      ? {
          view: 'source',
          file: target.file,
          line: target.line,
          document: undefined,
          anchor: undefined,
          symbol: undefined,
          lens: undefined,
        }
      : {
          view: route.view === 'home' && target.file === home.data?.file ? 'home' : 'readme',
          document: target.file,
          anchor: target.anchor,
        };
  const documentNavigation = {
    href: (target: DocumentTarget) => routeUrl({ ...route, ...documentRoute(target) }),
    open: (target: DocumentTarget) => navigate(documentRoute(target)),
  };
  const reindex = async () => {
    setBusy(true);
    setError('');
    setReindexError('');
    try {
      const controller = new AbortController();
      reindexController.current = controller;
      await request('reindex', controller.signal, 'POST');
      const fresh = await request<Status>('status', controller.signal);
      setStatus(fresh);
      navigate({ state: fresh.sourceId, line: 1 });
    } catch (e) {
      setReindexError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setDownloading(true);
    setDownloadError('');
    try {
      await hosted.download();
    } catch (e) {
      setDownloadError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };
  const contentError =
    route.view === 'readme'
      ? readme.error
      : route.view === 'home'
        ? home.error
        : route.view === 'source'
          ? source.error
          : '';
  const requestError = files.error || matches.error || imports.error || declarations.error || inspected.error;
  const resultLoaded =
    ready &&
    (Boolean(contentError) ||
      (route.view === 'home' && Boolean(home.data)) ||
      (route.view === 'readme' && Boolean(readme.data)) ||
      (route.view === 'source' && (!route.file || Boolean(source.data))) ||
      (route.view === 'map' &&
        (route.lens === 'references'
          ? !symbol ||
            Boolean(
              references.error ||
              inspected.error ||
              (selectedDeclaration && references.data) ||
              inspected.data?.results.length === 0,
            )
          : !route.file || Boolean(imports.data || imports.error))));
  useEffect(() => {
    if (!pendingFocus.current || !resultLoaded) return;
    const main = app.current?.querySelector<HTMLElement>('main');
    if (!main) return;
    const anchor = route.anchor
      ? Array.from(main.querySelectorAll<HTMLElement>('[id]')).find(
          element => element.id === `forge-document-${route.anchor}`,
        )
      : undefined;
    const target = anchor ?? main.querySelector<HTMLElement>('h1') ?? main;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
    pendingFocus.current = false;
  }, [resultLoaded, route]);
  return (
    <div className="app repository-app embedded" ref={app}>
      <div className="fx code-bar">
        <button type="button" className="fx-btn fx-btn-ghost fx-btn-sm" onClick={hosted.back}>
          ← Repositories
        </button>
        <strong title={status?.name}>{status?.name ?? 'GitHub repository'}</strong>
        <span className={`code-bar-state ${status?.freshness === 'current' ? 'current' : 'warning'}`}>
          {hosted.zone && status
            ? 'Pinned snapshot'
            : status?.freshness === 'current'
              ? 'Current'
              : status
                ? 'Source changed'
                : 'Not indexed yet'}
        </span>
        <span className="fx-faint">Partial analysis coverage</span>
        {hosted.canRefresh !== false && (
          <button
            type="button"
            className="fx-btn fx-btn-sm code-bar-action"
            onClick={() => void reindex()}
            disabled={busy}
          >
            {busy ? 'Indexing…' : status ? 'Re-index' : 'Index source'}
          </button>
        )}
      </div>
      <div className="repo-shell code-browser">
        <header className="code-heading">
          <h1>Code</h1>
        </header>
        <nav className="tabs repo-nav" aria-label="Repository views">
          {(['source', 'home', 'readme'] as const).map(tab => (
            <button
              key={tab}
              aria-current={route.view === tab ? 'page' : undefined}
              className={route.view === tab ? 'active' : ''}
              onClick={() => navigate({ view: tab, document: undefined, anchor: undefined })}
            >
              <Icon
                name={
                  (
                    {
                      home: 'home',
                      readme: 'source-review',
                      map: 'graph',
                      source: 'code',
                    } as Record<string, IconName>
                  )[tab]!
                }
              />
              <span>{tab === 'home' ? 'Overview' : tab === 'readme' ? 'Docs' : 'Files'}</span>
            </button>
          ))}
        </nav>
        {!route.file && <CodeChanges lanes={codeLanes} />}
        <div className="repo-body">
          {(error || reindexError || requestError) && (
            <ErrorToast read>{error || reindexError || requestError}</ErrorToast>
          )}
          {mismatch && (
            <ErrorToast>
              This link names another source state.{' '}
              <button onClick={() => navigate({ state: status!.sourceId, line: 1 })}>
                Load current state
              </button>
            </ErrorToast>
          )}
          {ready && hosted.saveView?.({ ...route, state })}
          {hosted.zone && (
            <div className="banner" role="status">
              Source Zone: {hosted.zone.name} · Pinned revision {hosted.zone.head.slice(0, 12)} · Selected
              files and graph only; repository documents omitted.
              {status?.upstreamFreshness === 'stale'
                ? ' Upstream source has changed; this Zone keeps its selected revision.'
                : status?.upstreamFreshness === 'unknown'
                  ? ' Upstream revision is currently unavailable.'
                  : ''}
            </div>
          )}
          {status?.freshness === 'stale' && (
            <div className="banner" role="status">
              {hosted.canRefresh === false
                ? 'Source has changed. The importer can re-index this snapshot.'
                : 'Source has changed. Re-index to inspect the current files.'}
            </div>
          )}
          {(status?.syntaxIssues ?? 0) > 0 && (
            <div className="banner">
              {status!.syntaxIssues} syntax issue(s); affected files have no declarations in this index.
            </div>
          )}
          {
            <div className={`workspace ${route.view === 'map' ? 'graph-workspace' : ''}`}>
              <aside className="sidebar" aria-label="Repository files">
                <label className="search">
                  <span className="sr-only">Find a file or symbol</span>
                  <svg
                    className="search-icon"
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <circle cx="10" cy="10" r="6" />
                    <path d="m15 15 5 5" />
                  </svg>
                  <input
                    value={search}
                    maxLength={256}
                    placeholder="Find a file or symbol"
                    onChange={e => {
                      setSearch(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <h2>Files</h2>
                {ready && (
                  <CodeFileTree
                    paths={files.data?.results.map(file => file.path) ?? []}
                    selected={route.file}
                    touched={touched}
                    select={selectFile}
                    query={search}
                  />
                )}
                {ready && files.data?.total === 0 && (
                  <p className="sidebar-note">
                    {search ? 'No matching files.' : 'No supported source files in this index.'}
                  </p>
                )}
                {files.data && files.data.total > 50 && (
                  <div className="pagination">
                    <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                      Previous
                    </button>
                    <span>
                      {offset + 1}–{offset + files.data.results.length} / {files.data.total}
                    </span>
                    <button
                      disabled={!files.data.truncated}
                      onClick={() => setOffset(offset + files.data!.results.length)}
                    >
                      Next
                    </button>
                  </div>
                )}
                {search && matches.data && (
                  <div className="symbol-search">
                    <h2>Symbols</h2>
                    {matches.data.results
                      .filter((item): item is SymbolNode => 'locator' in item)
                      .map(node => (
                        <button
                          key={node.id}
                          className="list-button"
                          onClick={() => openSource(node.locator.file, node.locator.start.line)}
                        >
                          {node.name}
                          <small>{node.locator.file}</small>
                        </button>
                      ))}
                    {matches.data.truncated && (
                      <p>Showing the first {matches.data.results.length} matches. Narrow your search.</p>
                    )}
                  </div>
                )}
              </aside>
              <main className={route.view === 'map' ? 'main map-view' : 'main'}>
                {!ready && (
                  <div className="empty">
                    <h1>
                      {busy
                        ? 'Building your source map'
                        : mismatch
                          ? 'Source state changed'
                          : status
                            ? 'Your index needs an update'
                            : 'Connecting to your repository'}
                    </h1>
                    <p>
                      {busy
                        ? 'Your previous index is retained until the new one is ready.'
                        : 'Loading the current source state from GitHub.'}
                    </p>
                  </div>
                )}
                {ready && contentError && (
                  <ErrorToast read>
                    <h1>Content unavailable</h1>
                    <p>{contentError}</p>
                  </ErrorToast>
                )}
                {ready &&
                  route.view === 'map' &&
                  route.lens === 'references' &&
                  (selectedDeclaration && references.data && status ? (
                    <ReferenceMap
                      symbol={selectedDeclaration}
                      references={references.data}
                      sourceId={state}
                      analysisId={status.analysisId}
                      source={openSource}
                    />
                  ) : (
                    <div className="empty">
                      <h1>Identifier references</h1>
                      <p>
                        {references.error || inspected.error ? (
                          <ErrorToast read error={references.error || inspected.error} />
                        ) : inspected.data?.results.length === 0 ? (
                          'The selected declaration is unavailable in this source snapshot.'
                        ) : symbol ? (
                          'Loading the selected declaration and its reference page.'
                        ) : (
                          'Choose Reference map beside a declaration in the file inspector.'
                        )}
                      </p>
                    </div>
                  ))}
                {ready && route.view === 'readme' && readme.data && (
                  <ReadmeView readme={readme.data} navigation={documentNavigation} />
                )}
                {ready && route.view === 'home' && home.data && status && (
                  <Home
                    document={home.data}
                    status={status}
                    request={request}
                    navigate={navigate}
                    navigation={documentNavigation}
                  />
                )}
                {ready && route.view === 'source' && source.data?.results[0] && (
                  <SourceView
                    touchedLines={codeLanes.flatMap(lane =>
                      lane.paths.filter(path => path.path === route.file).flatMap(path => path.lines ?? []),
                    )}
                    source={source.data.results[0]}
                    selectedLine={routeUrlState().searchParams.has('line') ? route.line : undefined}
                    navigate={line => navigate({ line })}
                  />
                )}
                {ready && !route.file && route.view === 'source' && (
                  <div className="empty">
                    <h1>Select a source file</h1>
                    <p>The file list shows the source included in this index.</p>
                  </div>
                )}
              </main>
              <Inspector
                incoming={ready ? incoming.data : null}
                incomingError={incoming.error}
                file={ready ? route.file : ''}
                declarations={ready ? declarations.data : null}
                imports={ready ? imports.data : null}
                references={ready ? references.data : null}
                referenceError={references.error}
                selectedSymbol={ready ? symbol : ''}
                selectSymbol={id => navigate({ symbol: id })}
                referenceMap={id => navigate({ view: 'map', symbol: id, lens: 'references' })}
                source={openSource}
                select={selectFile}
                link={routeUrl(route)}
                changing={route.file && <CodeChanges lanes={codeLanes} file={route.file} />}
                activity={<FileActivity file={route.file} status={status} />}
              />
            </div>
          }
        </div>
      </div>
      {status?.hosted && (
        <div className="upstream">
          <a href={status.hosted.upstream} target="_blank" rel="noreferrer noopener">
            Upstream repository
          </a>{' '}
          · {status.hosted.attributionScope === 'import-metadata' ? 'License at import' : 'License'}:{' '}
          {status.hosted.license}
          {status.hosted.currentLicense && status.hosted.currentLicense !== status.hosted.license && (
            <span> · Current upstream license: {status.hosted.currentLicense}</span>
          )}
          {status.sync && (
            <span>
              {' '}
              · Last GitHub check: {new Date(status.sync.checkedAt).toLocaleString()} —{' '}
              {status.sync.result === 'checked'
                ? status.sync.head === status.gitHead
                  ? 'indexed revision matches'
                  : 'source changed; Re-index to update'
                : status.sync.result === 'unavailable'
                  ? 'access or ref unavailable'
                  : 'check failed'}
            </span>
          )}
        </div>
      )}
      {status?.gitHead && (
        <div className="snapshot-download">
          <button disabled={downloading} onClick={() => void download()}>
            {downloading ? 'Downloading…' : hosted.zone ? 'Download Zone snapshot' : 'Download snapshot'}
          </button>
          <span>
            Indexed snapshot ·{' '}
            {hosted.zone ? 'selected source and graph; documents omitted' : 'source, graph and notices'}
          </span>
        </div>
      )}
      {downloadError && <ErrorToast>{downloadError}</ErrorToast>}
      {status && <UpstreamRequest source={publicRequestSource(status)} />}
    </div>
  );
}
