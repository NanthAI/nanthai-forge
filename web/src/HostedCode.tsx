import { countLabel } from './ui/count';
import { usePageCritical } from './ui/page-critical';
import { SourcePicker } from './shell/SourcePicker';
import { currentSource, sourceOptions } from './shell/source-options';
import { Breadcrumbs, workHref } from './shell/Breadcrumbs';
import { useReadRetry } from './ui/read-retry';
import { ErrorToast } from './ui/Toast';
import { ObjectActions, codeSourceLink } from './shell/ObjectActions';
import { useWorkRecords, type IntentHeader } from './hosted-work-index';
import type { HostedRunSummary, HostedViewSummary } from '../../src/work-hosted-summary';
import type { MoveRecord } from './cockpit/now-model';
import { useDestination } from './WorkspaceUI';
// SPDX-License-Identifier: Apache-2.0
import './code.css';
import { useAction, useConvex, useQuery } from 'convex/react';
import { workIndex } from './hosted-work-index';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ReviewPath, reviewTextPage } from '../../src/native-source-review';
import type { Lane } from '../../src/work-types';
import type { WorkIndexWorkspace } from './hosted-work-index';
import { CodeFileTree } from './CodeFileTree';
import { SourceView } from './Content';
import { CodeChanges, type CodeLane } from './CodeChanges';
import { codeImports } from './code-imports';
import { navigate } from './ui/navigation';
import { cleanUrl, routeUrlState } from './shell/location';
import { hostedError } from './snapshot';

type Index = { available: true; paths: ReviewPath[] } | { available: false; reason: string };
/** The URL file, else the root README.md, else the first file. */
export function defaultFile(paths: readonly string[]): string {
  return paths.includes('README.md')
    ? 'README.md'
    : (paths.find(path => !path.includes('/')) ?? paths[0] ?? '');
}
type File =
  | { available: true; file: ReviewPath; after: ReturnType<typeof reviewTextPage> | null }
  | { available: false; reason: string };

/** The existing source-review reader authorizes the checkpoint before and after every read. */
export default function HostedCode({
  projectId,
  workspace,
  head: currentMain,
  lanes,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  head: string;
  lanes: readonly Lane[];
}) {
  const readAttempt = useReadRetry();
  const intents = useWorkRecords<IntentHeader>(projectId, workspace, 'intents');
  const views = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const hostedMoves = useWorkRecords<MoveRecord & { head: string }>(projectId, workspace, 'hostedChannels');
  const localMoves = useWorkRecords<MoveRecord & { head: string }>(projectId, workspace, 'channelMoves');
  const read = useAction(api.projectSourceReview.read);
  const client = useConvex();
  const [index, setIndex] = useState<Index | null>(null);
  const [content, setContent] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useDestination('fileFilter');
  const [offset, setOffset] = useState(0);
  const [previous, setPrevious] = useState<number[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState('');
  const [changes, setChanges] = useState<readonly CodeLane[]>([]);
  const [locationKey, setLocationKey] = useState(location.href);
  const params = routeUrlState(locationKey).searchParams;
  // Any saved head in the URL only sets the Source picker; Code always renders this frame.
  const head = params.get('head') || params.get('sourceHead') || currentMain;
  const backupId = (params.get('sourceBackup') || workspace.backupId) as Id<'projectBackups'>;
  const line = Number(params.get('line') || /^#L(\d+)$/.exec(routeUrlState(locationKey).hash)?.[1]);
  const selectedLine = Number.isSafeInteger(line) && line > 0 ? line : undefined;
  const [retry, setRetry] = useState(0);
  const tree = useQuery(
    workIndex.detail,
    backupId === workspace.backupId
      ? { projectId, generationId: workspace.generationId, collection: 'sourceTrees', id: head }
      : 'skip',
  );
  const treePending = tree === undefined && backupId === workspace.backupId;
  const indexedTree = tree?.generationId === workspace.generationId && !!tree.value;
  const treePaths = useWorkRecords<{ paths: string[] }>(
    projectId,
    workspace,
    'sourceTreePaths',
    head,
    indexedTree,
  );
  const treeAvailable = indexedTree && treePaths.complete;
  const paths = treeAvailable
    ? treePaths.records.flatMap(row => row.paths.map(path => ({ path })))
    : index?.available
      ? index.paths
      : [];
  const selected = params.get('file') || defaultFile(paths.map(path => path.path));
  usePageCritical('Code', {
    tree: treeAvailable || index !== null,
    selectedFile: !selected || content !== null,
    laneOverlays: !changesLoading,
  });

  useEffect(() => {
    const update = () => setLocationKey(location.href);
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, []);
  const href = (file: string, view = 'source') => {
    const url = routeUrlState(locationKey);
    url.searchParams.set('projectTab', 'delivery');
    url.searchParams.set('file', file);
    // Reading main follows main; a chosen source stays pinned through `head`.
    url.searchParams.delete('sourceHead');
    if (head !== currentMain || params.has('head') || params.has('sourceHead'))
      url.searchParams.set('head', head);
    if (backupId !== workspace.backupId) url.searchParams.set('sourceBackup', backupId);
    url.searchParams.set('view', view);
    url.searchParams.delete('lane');
    url.searchParams.delete('line');
    url.hash = '';
    return cleanUrl(url.href);
  };
  const select = (file: string, view?: string) => {
    setOffset(0);
    setPrevious([]);
    navigate(href(file, view));
  };
  useEffect(() => {
    let current = true;
    setIndex(null);
    setError('');
    setChanges([]);
    if (treePending || indexedTree) return;
    void read({ projectId, backupId, base: head, head }).then(
      value => {
        if (current) setIndex(JSON.parse(value));
      },
      error => {
        if (current) setError(hostedError(error));
      },
    );
    return () => {
      current = false;
    };
  }, [read, projectId, backupId, head, retry, readAttempt, treePending, indexedTree, workspace.backupId]);
  const openKey = lanes
    .filter(
      lane =>
        !['completed', 'abandoned'].includes(lane.state) &&
        !('main' in lane && (lane.main as { included?: boolean })?.included),
    )
    .map(lane => `${lane.id}:${lane.base}:${lane.head}`)
    .join(',');
  useEffect(() => {
    let current = true;
    setChanges([]);
    setChangesError('');
    setChangesLoading(true);
    const open = openKey ? openKey.split(',') : [];
    const pins = new Map<string, Promise<boolean>>();
    const retained = (head: string) => {
      if (
        backupId !== workspace.backupId ||
        workspace.sourceTransport !== 'objects' ||
        workspace.counts?.sourcePins === undefined
      )
        return Promise.resolve(true);
      let pending = pins.get(head);
      if (!pending) {
        pending = client
          .query(workIndex.detail, {
            projectId,
            generationId: workspace.generationId,
            collection: 'sourcePins',
            id: head,
          })
          .then(pin => pin.generationId !== workspace.generationId || pin.value !== null);
        pins.set(head, pending);
      }
      return pending;
    };

    void (async () => {
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, open.length) }, async () => {
          while (cursor < open.length && current) {
            const key = open[cursor++]!;
            const [id, base, laneHead] = key.split(':') as [string, string, string];
            try {
              const available = await Promise.all([retained(base), retained(laneHead)]);
              if (!available.every(Boolean)) {
                if (current)
                  setChangesError('This source object is not retained in the selected checkpoint.');
                continue;
              }
              const value = JSON.parse(await read({ projectId, backupId, base, head: laneHead })) as Index;
              if (!current) return;
              if (!value.available) continue;
              const url = routeUrlState();
              url.searchParams.set('projectTab', 'lanes');
              url.searchParams.set('lane', id);
              url.searchParams.delete('file');
              url.searchParams.delete('view');
              setChanges(previous => [
                ...previous,
                {
                  id,
                  name: lanes.find(lane => lane.id === id)?.name ?? 'Lane',
                  href: cleanUrl(url.href),
                  paths: value.paths.filter(path => path.status !== 'unchanged'),
                },
              ]);
            } catch (error) {
              if (current) setChangesError(hostedError(error));
            }
          }
        }),
      );
      if (current) setChangesLoading(false);
    })();
    return () => {
      current = false;
    };
    // Lane identities include their exact base and head; display names do not trigger source reads.
  }, [
    client,
    read,
    projectId,
    backupId,
    openKey,
    retry,
    readAttempt,
    workspace.backupId,
    workspace.generationId,
    workspace.sourceTransport,
    workspace.counts?.sourcePins,
  ]);
  useEffect(() => {
    let current = true;
    setContent(null);
    setError('');
    if (selected)
      void read({
        projectId,
        backupId,
        base: head,
        head,
        file: selected,
        afterOffset: offset,
      }).then(
        value => {
          if (current) setContent(JSON.parse(value));
        },
        error => {
          if (current) setError(hostedError(error));
        },
      );
    return () => {
      current = false;
    };
  }, [read, projectId, backupId, head, selected, offset, retry, readAttempt]);
  const touched = new Set(changes.flatMap(lane => lane.paths.map(path => path.path)));
  const now = Date.now();
  const sources = sourceOptions({
    main: currentMain,
    now,
    lanes,
    views: views.records,
    intents: intents.records,
    // Native Channels: hosted selections first, then retained owner acceptances (as the main strip).
    moves: [...hostedMoves.records, ...localMoves.records],
    runs: runs.records,
  });
  const page = content?.available && content.after?.kind === 'text' ? content.after : null;
  const edges = useMemo(
    () => (page?.offset === 0 ? codeImports(selected, page.text, new Set(paths.map(path => path.path))) : []),
    [page, selected, paths],
  );
  return (
    <section className="code-browser hosted-code" aria-label="Project code">
      {params.get('sourceLane') &&
        (() => {
          const lane = lanes.find(lane => lane.id === params.get('sourceLane'));
          return lane ? (
            <Breadcrumbs
              items={[
                {
                  label: intents.records.find(intent => intent.id === lane.intentId)?.outcome ?? 'Intent',
                  href: workHref({ intent: lane.intentId }),
                },
                { label: lane.name, href: workHref({ projectTab: 'lanes', lane: lane.id }) },
                ...(selected ? [{ label: selected, href: href(selected) }] : []),
              ]}
            />
          ) : null;
        })()}
      <header className="code-heading">
        <h1>Code</h1>
        <SourcePicker
          current={currentSource(head, params.get('sourceLane') ?? undefined, sources, lanes)}
          options={sources}
          choose={(selected, laneId) => {
            if (selected) navigate(codeSourceLink(selected, laneId));
            else {
              const url = routeUrlState();
              for (const key of ['head', 'sourceHead', 'sourceBackup', 'sourceLane'])
                url.searchParams.delete(key);
              navigate(cleanUrl(url));
            }
          }}
        />
        <ObjectActions head={head} />
      </header>
      {changesError && (
        <ErrorToast
          read
          error="Some Lane changes are unavailable."
          retry={() => setRetry(value => value + 1)}
        />
      )}
      {error && (
        <ErrorToast read>
          {error} <button onClick={() => setRetry(value => value + 1)}>Retry</button>
        </ErrorToast>
      )}
      {index && !index.available && (
        <ErrorToast read error={index.reason} retry={() => setRetry(value => value + 1)} />
      )}
      <div className="workspace">
        <aside className="sidebar" aria-label="Repository files">
          <label className="search">
            <span className="sr-only">Find a file</span>
            <input
              type="search"
              aria-label="Find a file"
              placeholder="Find a file"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <h2>
            Files <span>{paths.length}</span>
          </h2>
          {!index && !treeAvailable && (
            <p role="status" className="code-loading">
              Loading files…
            </p>
          )}
          <CodeFileTree
            paths={paths.map(path => path.path)}
            selected={selected}
            touched={touched}
            select={select}
            query={query}
          />
          {(index?.available || treeAvailable) && !paths.length && (
            <p className="code-loading">No files in main.</p>
          )}
        </aside>
        <main className="main">
          {page && content?.available ? (
            <>
              <SourceView
                head={head}
                source={{
                  file: selected,
                  digest: content.file.after!.blob,
                  text: page.text,
                  startLine: page.line,
                  endLine: page.line + page.text.split('\n').length - 1,
                  totalLines:
                    page.nextOffset === null
                      ? page.line + page.text.split('\n').length - 1
                      : Number.MAX_SAFE_INTEGER,
                }}
                selectedLine={selectedLine}
                changing={
                  changes.some(lane => lane.paths.some(path => path.path === selected)) ? (
                    <div className="code-changing">
                      <a href="#code-this-file">
                        {countLabel(
                          changes.filter(lane => lane.paths.some(path => path.path === selected)).length,
                          'Lane',
                        )}{' '}
                        on this file
                      </a>
                    </div>
                  ) : undefined
                }
                navigate={line => {
                  if (line < page.line) {
                    const next = [...previous];
                    setOffset(next.pop() ?? 0);
                    setPrevious(next);
                  } else if (page.nextOffset !== null) {
                    setPrevious(values => [...values, offset]);
                    setOffset(page.nextOffset);
                  }
                }}
              />
            </>
          ) : (
            <div className="empty" role="status">
              {content && !content.available ? (
                <ErrorToast read error={content.reason} retry={() => setRetry(value => value + 1)} />
              ) : content?.available && content.after?.kind === 'binary' ? (
                'Binary file'
              ) : selected || (!index && !treeAvailable) ? (
                'Loading source…'
              ) : null}
            </div>
          )}
        </main>
        <aside className="inspector" aria-label="This file" id="code-this-file">
          <h2>This file</h2>
          <p className="inspector-file">{selected}</p>
          {selected && <CodeChanges lanes={changes} file={selected} />}
          <section className="inspector-section">
            <h3>Imports</h3>
            {edges.map(edge => (
              <button className="file-row" key={edge.to} onClick={() => select(edge.to)}>
                {edge.to}
              </button>
            ))}
            {selected && !edges.length && <p>No resolved imports in this source page.</p>}
          </section>
          <details className="inspector-section">
            <summary>Exact record</summary>
            <p>
              main · <code>{head}</code>
            </p>
            {content?.available && <small>{content.file.after?.blob.slice(0, 12)}</small>}
          </details>
        </aside>
      </div>
    </section>
  );
}
