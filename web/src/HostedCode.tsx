import { useSourceReview } from './use-source-review';
import { usePageCritical } from './ui/page-critical';
import { SourcePicker } from './shell/SourcePicker';
import { currentSource, sourceOptions } from './shell/source-options';
import { Breadcrumbs, workHref } from './shell/Breadcrumbs';
import { useReadRetry } from './ui/read-retry';
import { ErrorToast } from './ui/Toast';
import { ObjectActions, codeSourceLink, savedLink } from './shell/ObjectActions';
import { useWorkRecords, type IntentHeader } from './hosted-work-index';
import type { HostedRunSummary, HostedViewSummary } from '../../src/work-hosted-summary';
import { publishedMoves, type MoveRecord } from './cockpit/now-model';
import { useDestination } from './WorkspaceUI';
// SPDX-License-Identifier: Apache-2.0
import './code.css';
import { useConvex, useQuery } from 'convex/react';
import { workIndex } from './hosted-work-index';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Id } from '../../convex/_generated/dataModel';
import type { ReviewPath, reviewTextPage } from '../../src/native-source-review';
import type { Lane } from '../../src/work-types';
import type { WorkIndexWorkspace } from './hosted-work-index';
import { CodeFileTree, treeCounts } from './CodeFileTree';
import { SourceView } from './Content';
import type { CodeLane } from './CodeChanges';
import { changedLines, fileSymbols, laneTone, treeTouches, type TouchLane } from './code-file-model';
import {
  ChangingNowPanel,
  ChangingStrip,
  FileHeader,
  HistoryPanel,
  SymbolsPanel,
  type FileChange,
  type FileLane,
} from './CodeThisFile';
import { Button } from './ui/primitives';
import { Sheet } from './ui/Sheet';
import { Glyph } from './ui/Glyph';
import { age } from './ui/status';
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
  const read = useSourceReview();
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
              setChanges(previous => [
                ...previous,
                {
                  id,
                  name: lanes.find(lane => lane.id === id)?.name ?? 'Lane',
                  href: laneHref(id),
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
  const now = Date.now();
  const touchLanes = useMemo(
    () =>
      changes.flatMap((change): TouchLane[] => {
        const lane = lanes.find(lane => lane.id === change.id) as LaneRecord | undefined;
        if (!lane) return [];
        const holder = lane.assignment?.trim();
        return [
          {
            id: lane.id,
            name: lane.name,
            holder: holder || lane.name,
            agent: lane.startedBy?.kind === 'agent' || (!!holder && holder !== lane.startedBy?.name),
            what: intents.records.find(intent => intent.id === lane.intentId)?.outcome ?? '',
            saves: lane.checkpointCount ?? lane.checkpoints?.length ?? 0,
            tone: laneTone(lane, views.records, runs.records),
            href: change.href,
            paths: change.paths.map(path => path.path),
          },
        ];
      }),
    [changes, lanes, intents.records, views.records, runs.records],
  );
  const touched = useMemo(() => treeTouches(touchLanes), [touchLanes]);
  const onFile = touchLanes.filter(lane => lane.paths.includes(selected));
  const onFileKey = onFile.map(lane => lane.id).join(',');
  // Lines each Lane changes in the selected file: one comparison read per touching Lane, cached.
  const lineCache = useRef(new Map<string, [number, number][]>());
  const lineReads = useRef(new Set<string>());
  const [lineTick, setLineTick] = useState(0);
  useEffect(() => {
    for (const id of onFileKey ? onFileKey.split(',') : []) {
      const lane = lanes.find(lane => lane.id === id);
      if (!lane) continue;
      const key = `${backupId}:${lane.base}:${lane.head}:${selected}`;
      if (lineReads.current.has(key)) continue;
      lineReads.current.add(key);
      void read({ projectId, backupId, base: lane.base, head: lane.head, file: selected }).then(
        value => {
          const result = JSON.parse(value) as { comparison?: { hunks?: Parameters<typeof changedLines>[0] } };
          lineCache.current.set(key, changedLines(result.comparison?.hunks ?? []));
          setLineTick(tick => tick + 1);
        },
        // Lines are a hint; the Lane entry still shows without them, and a later visit retries.
        () => lineReads.current.delete(key),
      );
    }
  }, [read, projectId, backupId, selected, onFileKey, lanes]);
  const fileLanes: FileLane[] = useMemo(
    () =>
      onFile.map(lane => {
        const record = lanes.find(item => item.id === lane.id)!;
        const lines = lineCache.current.get(`${backupId}:${record.base}:${record.head}:${selected}`);
        return {
          ...lane,
          href: laneHref(lane.id, selected),
          ...(lines ? { lines } : {}),
        };
      }),
    // lineTick re-reads the cache after a comparison arrives.
    [onFileKey, touchLanes, lineTick, backupId, selected],
  );
  const accepted = useMemo(
    () =>
      publishedMoves(localMoves.records, hostedMoves.records)
        .filter(move => move.channel === 'main' && (!move.status || move.status === 'accepted'))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, HISTORY_SCAN),
    [localMoves.records, hostedMoves.records],
  );
  const history = useFileHistory({
    read,
    projectId,
    backupId,
    file: selected,
    moves: accepted,
    views: views.records,
    runs: runs.records,
    intents: intents.records,
  });
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
  const symbols = useMemo(
    () => (page?.offset === 0 ? fileSymbols(selected, page.text, page.line) : []),
    [page, selected],
  );
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => setCopied(''), [selected, head]);
  const find = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        if (find.current?.offsetParent) find.current.focus();
        else setSheet(true);
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  const lineCount = page && page.nextOffset === null ? page.line + page.text.split('\n').length - 1 : 0;
  // A final newline is not a line of its own.
  const lines = page?.text.endsWith('\n') && lineCount > 1 ? lineCount - 1 : lineCount;
  const meta = [
    lines ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : page ? `lines ${page.line}+` : '',
    history.changes[0] ? `accepted ${age(history.changes[0].at, now, true)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const raw = async () => {
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const value = JSON.parse(
        await read({ projectId, backupId, base: head, head, file: selected, afterOffset: offset }),
      ) as File;
      if (!value.available || value.after?.kind !== 'text')
        return setError('Raw text is unavailable for this file.');
      parts.push(value.after.text);
      offset = value.after.nextOffset;
    }
    window.open(
      URL.createObjectURL(new Blob(parts, { type: 'text/plain;charset=utf-8' })),
      '_blank',
      'noopener',
    );
  };
  const fileTree = (input?: boolean) => (
    <>
      <label className="search code-find">
        <Glyph name="search" size={13} />
        <span className="sr-only">Find a file</span>
        <input
          ref={input ? find : undefined}
          type="search"
          aria-label="Find a file"
          placeholder="Find a file"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <kbd aria-hidden="true">⌘P</kbd>
      </label>
      {paths.length > 0 && <p className="code-tree-count">{treeCounts(paths.map(path => path.path))}</p>}
      {!index && !treeAvailable && (
        <p role="status" className="code-loading">
          Loading files…
        </p>
      )}
      <CodeFileTree
        paths={paths.map(path => path.path)}
        selected={selected}
        touched={touched}
        select={path => {
          setSheet(false);
          select(path);
        }}
        query={query}
      />
      {(index?.available || treeAvailable) && !paths.length && (
        <p className="code-loading">No files in main.</p>
      )}
    </>
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
      {sheet && (
        <Sheet title="Files" glyph="folder" onClose={() => setSheet(false)} width={360}>
          <div className="code-browser hosted-code code-files-sheet">{fileTree()}</div>
        </Sheet>
      )}
      <div className="workspace">
        <aside className="sidebar" aria-label="Repository files">
          {fileTree(true)}
        </aside>
        <main className="main">
          {page && content?.available ? (
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
              header={
                <FileHeader
                  file={selected}
                  meta={meta}
                  files={() => setSheet(true)}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="copy"
                        onClick={() =>
                          void navigator.clipboard.writeText(savedLink(head, selected, selectedLine)).then(
                            () => setCopied('Copied'),
                            () => setCopied('Could not copy'),
                          )
                        }
                      >
                        {copied || 'Copy link'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          document.getElementById('code-history')?.scrollIntoView({ block: 'start' })
                        }
                        disabled={!history.loading && !history.changes.length}
                      >
                        History
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void raw()}>
                        Raw
                      </Button>
                    </>
                  }
                />
              }
              changing={<ChangingStrip lanes={fileLanes} />}
              touchedLines={fileLanes.flatMap(lane =>
                (lane.lines ?? []).map(([start, end]) => [start, end, lane.tone] as const),
              )}
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
        <aside className="inspector code-this-file" aria-label="This file" id="code-this-file">
          <ChangingNowPanel lanes={fileLanes} />
          <SymbolsPanel symbols={symbols} href={line => href(selected) + `#L${line}`} />
          <HistoryPanel changes={history.changes} loading={history.loading} now={now} />
        </aside>
      </div>
    </section>
  );
}

type LaneRecord = Lane & {
  assignment?: string;
  checkpointCount?: number;
  startedBy?: { kind?: string; name?: string };
};
/** A Work page link without the Code page's file and source parameters. */
function pageHref(params: Record<string, string>): string {
  const url = routeUrlState();
  for (const key of [
    'file',
    'view',
    'head',
    'sourceHead',
    'sourceLane',
    'sourceBackup',
    'line',
    'fileFilter',
  ])
    url.searchParams.delete(key);
  url.hash = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return cleanUrl(url.href);
}
/** The Lane page, with this file selected in its Changes. */
const laneHref = (lane: string, file?: string) =>
  pageHref({ projectTab: 'lanes', lane, ...(file ? { diffFile: file } : {}) });

/** Recent acceptances scanned for the selected file's History. */
const HISTORY_SCAN = 8;
// Changed paths per exact Candidate; immutable, so shared across files and visits.
const candidatePaths = new Map<string, Promise<ReadonlySet<string> | null>>();

function useFileHistory({
  read,
  projectId,
  backupId,
  file,
  moves,
  views,
  runs,
  intents,
}: {
  read: (args: {
    projectId: Id<'hostedProjects'>;
    backupId: Id<'projectBackups'>;
    base: string;
    head: string;
  }) => Promise<string>;
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  file: string;
  moves: readonly MoveRecord[];
  views: readonly HostedViewSummary[];
  runs: readonly HostedRunSummary[];
  intents: readonly IntentHeader[];
}) {
  const [state, setState] = useState<{ key: string; changes: FileChange[]; loading: boolean }>({
    key: '',
    changes: [],
    loading: false,
  });
  const entries = moves.flatMap(move => {
    const view = views.find(view => view.id === move.viewId);
    return view?.base && view.head ? [{ move, view: view as HostedViewSummary & { head: string } }] : [];
  });
  const key = `${backupId}:${file}:${entries.map(entry => entry.move.viewId).join(',')}`;
  useEffect(() => {
    if (!file || !entries.length) {
      setState({ key, changes: [], loading: false });
      return;
    }
    let current = true;
    setState({ key, changes: [], loading: true });
    void (async () => {
      const found: FileChange[] = [];
      for (const { move, view } of entries) {
        const id = `${backupId}:${view.base}:${view.head}`;
        let paths = candidatePaths.get(id);
        if (!paths) {
          paths = read({ projectId, backupId, base: view.base, head: view.head }).then(
            value => {
              const result = JSON.parse(value) as Index;
              return result.available
                ? new Set(result.paths.filter(path => path.status !== 'unchanged').map(path => path.path))
                : null;
            },
            () => null,
          );
          candidatePaths.set(id, paths);
        }
        const changed = await paths;
        if (!current) return;
        if (!changed?.has(file)) continue;
        const run = runs.filter(run => run.viewId === view.id && run.status === 'passed').at(-1);
        const minutes =
          run?.endedAt && run.startedAt
            ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60_000)
            : undefined;
        found.push({
          viewId: view.id,
          title: intents.find(intent => intent.id === view.intentId)?.outcome ?? 'Candidate',
          href: pageHref({ projectTab: 'views', viewId: view.id }),
          head: view.head,
          at: move.at,
          by: move.acceptedBy?.name ?? move.actorDisplayName,
          auto: !!move.automatic,
          ...(run
            ? { check: `${run.checkName.split(' · ')[0]}${minutes !== undefined ? ` ${minutes} min` : ''}` }
            : {}),
        });
        setState({ key, changes: [...found], loading: true });
      }
      if (current) setState({ key, changes: found, loading: false });
    })();
    return () => {
      current = false;
    };
    // `key` names the file and the exact Candidates scanned.
  }, [key, read, projectId]);
  return state.key === key ? state : { key, changes: [], loading: !!file && entries.length > 0 };
}
