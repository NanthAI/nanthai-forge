// SPDX-License-Identifier: Apache-2.0
// Plan (Items d3357f40, b7a0dff1, e0a23825, 65b0e706): one hand-ordered list grouped by Initiative. The page sentence
// and the standing line answer what is done, in progress and left; "next" is derived from state
// (src/planning-model.ts nextItem), never stored. The view (scope, filters, order, list / tree / board, find) lives
// in the address; ticked rows change together in one batch with one Undo. Loaded with its route only.
// Reads: projectPlanView:read, one subscription, re-run only by planning writes in the ranges it read; the Closed and
// Everything scopes add one bounded page each of done and dropped Items (projectPlanSettled:page). Writes:
// projectWorkCommand:command for one row, projectPlanningBatch:apply for a selection, each retry-safe by its
// operation id.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConvex, useMutation } from 'convex/react';
import { makeFunctionReference, type PaginationResult } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, Key, Region, Row, Standing, Who } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { inverseRelationLabel, isLive, itemStatusLabel } from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { planningBatchLimit } from '../../../../src/planning-batch';
import { useSafePaginatedQuery, useSafeQuery } from '../../safe-query';
import { A } from '../frames';
import { currentScreenHref, hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import { progressCells, progressOf, type PlanCountsRead } from '../progress';
import { navigate, useSearch } from '../router';
import type { PlaceProps } from '../screens';
import { readComments, readItems, runBatch, batchApply, type BatchOutcome, type RunBatch } from './batch';
import { Board } from './Board';
import { Capture } from './Capture';
import { isShut, NO_INITIATIVE, usePlanFolds } from './fold';
import { Groups } from './Groups';
import { InitiativePage } from './Initiative';
import { COLS, DoneWhen, Line, Status } from './rows';
import { Tick, type Ticker } from './Tick';
import { Versions } from './Versions';
import { BulkBar, SplitSheet, UndoToast, outcomeWords, type Reads } from './Bulk';
import {
  matches,
  movedInitiativeRank,
  movedRank,
  planSentence,
  planView,
  statusOf,
  type PlanGroup,
  type PlanRead,
  type PlanView,
} from './model';
import { filtered, keeps, readQuery, sortRows, writeQuery, type PlanQuery } from './query';
import { Toolbar, ViewsColumn } from './Views';
import './plan.css';

const planRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, PlanRead>(
  'projectPlanView:read',
);
const settledPage = makeFunctionReference<
  'query',
  {
    projectId: Id<'hostedProjects'>;
    status: 'closed' | 'abandoned';
    initiativeId?: string;
    paginationOpts: { cursor: string | null; numItems: number };
  },
  PaginationResult<string>
>('projectPlanSettled:page');
/** An Item's comments (Item 9a3d6f5f) load with the Item page only, so the list never loads the Markdown renderer. */
const ItemDiscussion = lazy(() => import('../discussion/ItemDiscussion'));

export type Put = (command: Record<string, unknown>) => Promise<unknown>;

export default function Plan(props: PlaceProps) {
  return <PlanScreen {...props} />;
}

/** Done and dropped Items, a page of 50 at a time, only while the scope (or an Initiative page) asks for them; with
 * an Initiative, only its Items, read by the server's Initiative index. */
function useSettled(
  projectId: Id<'hostedProjects'>,
  status: 'closed' | 'abandoned',
  on: boolean,
  initiativeId: string | undefined,
) {
  const pages = useSafePaginatedQuery(
    settledPage,
    on ? { projectId, status, ...(initiativeId ? { initiativeId } : {}) } : 'skip',
    {
      initialNumItems: 50,
    },
  );
  const rows = useMemo(
    () =>
      pages.results.flatMap(value => {
        try {
          return [JSON.parse(value) as PlanRow];
        } catch {
          return [];
        }
      }),
    [pages.results],
  );
  return {
    rows,
    more: pages.status === 'CanLoadMore',
    loading: on && (pages.status === 'LoadingFirstPage' || pages.status === 'LoadingMore'),
    failed: pages.status === 'Error',
    loadMore: () => pages.loadMore(50),
  };
}
export type Settled = ReturnType<typeof useSettled>;

function PlanScreen({ route, projectId, projectName, feed, viewerHandle }: PlaceProps) {
  const search = useSearch();
  const query = useMemo(() => readQuery(search), [search.toString()]);
  const live = useSafeQuery(planRead, { projectId });
  const counts = useSafeQuery(api.projectPlanCounts.read, { projectId });
  // A failed or offline refresh keeps the last rows and the chosen view; the page says so.
  const last = useRef<PlanRead | undefined>(undefined);
  if (live.value) last.current = live.value;
  const read = live.value ?? last.current;
  // An Initiative page asks for its own done and dropped Items while that fold is open.
  const [doneFor, showDone] = useState<string | null>(null);
  const settledOn = query.scope !== 'open' || doneFor !== null;
  const settledIn = doneFor ?? query.initiative;
  const closed = useSettled(projectId, 'closed', settledOn, settledIn);
  const dropped = useSettled(projectId, 'abandoned', settledOn, settledIn);
  const mutate = useMutation(api.projectWorkCommand.command);
  const apply = useMutation(batchApply);
  const client = useConvex();
  const put: Put = command => {
    const operationId = crypto.randomUUID();
    return mutate({
      projectId,
      operationId,
      command: JSON.stringify({ action: 'put-planning-item', operationId, ...command }),
    });
  };
  const run: RunBatch = writes => runBatch(apply, projectId, writes);
  const reads: Reads = {
    items: ids => readItems(client, projectId, ids),
    comments: ids => readComments(client, projectId, ids),
  };
  const go = (patch: Partial<PlanQuery>) => {
    const next = { ...query, ...patch };
    // Typing in Find replaces the address; any other change is a step Back can undo.
    const onlyFind = Object.keys(patch).every(key => key === 'find');
    navigate(location.pathname + writeQuery(next), { replace: onlyFind });
  };
  return (
    <PlanScreenView
      route={route}
      projectId={projectId}
      projectName={projectName}
      feed={feed}
      read={read}
      stale={Boolean(live.error) && Boolean(last.current)}
      put={put}
      run={run}
      reads={reads}
      query={query}
      go={go}
      viewer={viewerHandle}
      closed={closed}
      dropped={dropped}
      showDone={showDone}
      progress={counts.value}
    />
  );
}

const noSettled: Settled = {
  rows: [],
  more: false,
  loading: false,
  failed: false,
  loadMore: () => undefined,
};
const scopeWords = { open: 'Open work', closed: 'Done and dropped', all: 'Everything' } as const;
const ownerOf = (owner: string | null | undefined) => owner?.replace(/^@/, '').split('/')[0];

/** The screen from its read; an `undefined` read draws as loading. */
export function PlanScreenView({
  route,
  projectId,
  projectName,
  feed,
  read,
  stale = false,
  put,
  run,
  reads,
  query = readQuery(new URLSearchParams()),
  go = () => undefined,
  viewer,
  closed = noSettled,
  dropped = noSettled,
  showDone = () => undefined,
  progress: progressRead,
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed'> & {
  /** The project's progress counts (convex/projectPlanCounts.ts), the same read Needs me shows. */
  progress?: PlanCountsRead | undefined;
  /** Hosted reads for the Item page's comments and versions; without it the page draws neither. */
  projectId?: Id<'hostedProjects'> | undefined;
  read: PlanRead | undefined;
  stale?: boolean;
  put: Put;
  run?: RunBatch;
  reads?: Reads;
  query?: PlanQuery;
  go?: (patch: Partial<PlanQuery>) => void;
  viewer?: string | undefined;
  closed?: Settled;
  dropped?: Settled;
  /** The Initiative page's done and dropped fold: subscribe for one Initiative, or drop it (null). */
  showDone?: (initiativeId: string | null) => void;
}) {
  const [orders, setOrders] = useState<ReadonlyMap<string, string>>(new Map());
  const [capture, setCapture] = useState(false);
  const [split, setSplit] = useState(false);
  const [versions, setVersions] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<{ outcome: BatchOutcome; words: string } | null>(null);
  const [message, announce] = useAnnounce();
  const { folds, toggle: toggleFold, setAll: setFolds } = usePlanFolds(projectId ?? '');
  const find = query.find;
  const keep = useMemo(() => (row: PlanRow) => keeps(row, query), [query]);
  const view = useMemo(
    () => (read ? planView(read, find.trim(), orders, keep) : null),
    [read, find, orders, keep],
  );
  const at = (patch: Partial<PlaceProps['route']>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const initiativeRow = route.rest
    ? [...(view?.byId.values() ?? [])].find(
        entry => entry.kind === 'initiative' && entry.id.startsWith(route.rest),
      )
    : undefined;
  const canCapture = Boolean(view?.canEdit) && (!route.rest || Boolean(initiativeRow));
  useEffect(() => {
    if (!canCapture) return;
    // "n" opens New Item, as its key shows, unless the reader is typing or holding a modifier.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented)
        return;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      setCapture(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [canCapture]);
  // A changed view keeps no hidden selection: only rows that can be seen stay ticked.
  useEffect(() => setPicked(new Set()), [writeQuery({ ...query, find: '' })]);
  const whole = useMemo(() => (read ? planView(read, '', orders) : null), [read, orders]);
  const settledRows = useMemo(
    () =>
      [...closed.rows, ...dropped.rows].filter(
        row => row.kind === 'issue' && keep(row) && (!find.trim() || matches(row, find.trim())),
      ),
    [closed.rows, dropped.rows, keep, find],
  );
  const byId = useMemo(() => {
    const map = new Map(view?.byId ?? []);
    for (const row of [...closed.rows, ...dropped.rows]) map.set(row.id, row);
    return map;
  }, [view, closed.rows, dropped.rows]);
  if (route.rest && !initiativeRow)
    return (
      <ItemPage
        route={route}
        projectName={projectName}
        view={whole}
        at={at}
        projectId={projectId}
        onSplit={whole?.canEdit && reads && run ? () => setSplit(true) : undefined}
        onVersions={projectId ? () => setVersions(true) : undefined}
        versions={
          versions && projectId ? (
            <Versions
              projectId={projectId}
              itemId={
                [...(whole?.byId.values() ?? [])].find(entry => entry.id.startsWith(route.rest))?.id ??
                route.rest
              }
              canEdit={Boolean(whole?.canEdit)}
              put={put}
              onOpenChange={setVersions}
              announce={announce}
            />
          ) : null
        }
        split={
          split && reads && run ? (
            <SplitSheet
              onOpenChange={setSplit}
              row={
                [...(whole?.byId.values() ?? [])].find(entry => entry.id.startsWith(route.rest)) ?? {
                  id: route.rest,
                  title: route.rest.slice(0, 8),
                }
              }
              reads={reads}
              go={async writes => {
                const outcome = await run(writes);
                setToast({ outcome, words: outcomeWords(outcome, byId) });
                return outcome;
              }}
            />
          ) : null
        }
        toast={
          toast && run ? (
            <UndoToast
              {...toast}
              run={run}
              byId={byId}
              onGone={words => (setToast(null), words && announce(words))}
            />
          ) : null
        }
      />
    );
  const sentence = view ? planSentence(view) : null;
  const lanesOpen = feed ? feed.lanes.length + feed.more : null;
  const byHand = query.sort === 'hand' && !filtered(query);
  const openShown = query.scope !== 'closed';
  const liveShown = view ? view.groups.reduce((sum, group) => sum + group.lines.length, 0) : 0;
  const shown = (openShown ? liveShown : 0) + (query.scope === 'open' ? 0 : settledRows.length);
  const loadedIds = [
    ...(openShown && view ? view.groups.flatMap(group => group.lines.map(line => line.row.id)) : []),
    ...(query.scope === 'open' ? [] : settledRows.map(row => row.id)),
  ];
  const selected = [...picked].map(id => byId.get(id)).filter((row): row is PlanRow => Boolean(row));
  const canEdit = Boolean(view?.canEdit) && Boolean(run);
  const tick = (id: string) =>
    setPicked(previous => {
      const next = new Set(previous);
      if (!next.delete(id)) {
        if (next.size >= planningBatchLimit) return previous;
        next.add(id);
      }
      return next;
    });
  const ticker = canEdit ? { picked, tick } : undefined;
  const owners = [
    ...new Set(
      [...(view?.byId.values() ?? [])].flatMap(row => (row.owner ? [row.owner.split('/')[0]!] : [])),
    ),
  ].sort();
  const types = [...new Set([...(view?.byId.values() ?? [])].flatMap(row => (row.type ? [row.type] : [])))];
  const initiatives = whole?.groups.flatMap(group => (group.initiative ? [group.initiative] : [])) ?? [];
  const liveItems = [...(view?.byId.values() ?? [])].filter(row => row.kind === 'issue' && isLive(row));
  const me = viewer?.replace(/^@/, '');
  const counts = {
    open: whole?.live ?? 0,
    mine: me ? liveItems.filter(row => ownerOf(row.owner) === me).length : 0,
    unowned: liveItems.filter(row => !row.owner).length,
  };
  const words = [
    query.type ? `type ${query.type}` : '',
    query.owner ? (query.owner === 'none' ? 'no owner' : `owner ${query.owner}`) : '',
    query.relation ? `relation ${query.relation}` : '',
    query.initiative
      ? `in ${initiatives.find(row => row.id === query.initiative)?.title ?? 'one Initiative'}`
      : '',
    find.trim() ? `matching “${find.trim()}”` : '',
  ].filter(Boolean);

  const move = (group: PlanGroup, id: string, toIndex: number) => {
    const ids = group.lines.map(line => line.row.id).filter(other => other !== id);
    ids.splice(toIndex, 0, id);
    const order = movedRank(group.lines, ids, id);
    const row = view?.byId.get(id);
    if (!order || !row) return;
    setOrders(previous => new Map(previous).set(id, order));
    setError('');
    put({ itemId: id, expectedVersion: row.version ?? 0, order }).then(
      () => undefined,
      () => {
        setOrders(previous => {
          const next = new Map(previous);
          next.delete(id);
          return next;
        });
        setError(`Forge could not move ${row.title}; it is back where it was.`);
      },
    );
  };
  /** An Initiative moved among those shown: one order write between its new neighbours, as for an Item. */
  const moveInitiative = (id: string, toIndex: number) => {
    const shown = (view?.groups ?? []).flatMap(group =>
      group.initiative && (!filtered(query) || group.lines.length) ? [group.initiative] : [],
    );
    const ids = shown.map(row => row.id).filter(other => other !== id);
    ids.splice(toIndex, 0, id);
    const order = movedInitiativeRank(shown, ids, id);
    const row = view?.byId.get(id);
    if (!order || !row) return;
    setOrders(previous => new Map(previous).set(id, order));
    setError('');
    put({ itemId: id, expectedVersion: row.version ?? 0, order }).then(
      () => announce(`${row.title} moved to position ${toIndex + 1} of ${shown.length}.`),
      () => {
        setOrders(previous => {
          const next = new Map(previous);
          next.delete(id);
          return next;
        });
        setError(`Forge could not move ${row.title}; it is back where it was.`);
      },
    );
  };
  const captureSheet = view?.canEdit ? (
    <Capture
      open={capture}
      onOpenChange={setCapture}
      view={view}
      put={put}
      announce={announce}
      initiative={initiativeRow?.id ?? ''}
    />
  ) : null;
  if (initiativeRow && whole)
    return (
      <>
        <InitiativePage
          route={route}
          projectName={projectName}
          initiative={initiativeRow}
          view={whole}
          at={at}
          put={put}
          reads={reads}
          closed={closed}
          dropped={dropped}
          onShowDone={showDone}
          onMove={move}
          error={error}
          onNew={() => setCapture(true)}
          announce={announce}
        />
        {captureSheet}
        <Announcer message={message} />
      </>
    );
  const allShut =
    Boolean(view?.groups.length) &&
    (view?.groups ?? []).every(group => isShut(folds, group.initiative?.id ?? NO_INITIATIVE));
  const anyShut = (view?.groups ?? []).some(group => isShut(folds, group.initiative?.id ?? NO_INITIATIVE));
  const done = (outcome: BatchOutcome, extra: string) => {
    const text = [outcomeWords(outcome, byId), extra].filter(Boolean).join(' ');
    // Rows that changed leave the selection; refused rows stay ticked so they can be tried again.
    setPicked(
      new Set(outcome.results.filter(result => result.outcome === 'refused').map(result => result.itemId)),
    );
    setToast({ outcome, words: text });
    announce(text);
  };

  return (
    <div className="plan plan-with-views">
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          sentence ? (
            <>
              <b>{sentence.bold}</b> {sentence.rest}
            </>
          ) : (
            'Loading the plan…'
          )
        }
      >
        {view?.canEdit ? (
          <Key size="sm" keys="n" onClick={() => setCapture(true)}>
            New Item
          </Key>
        ) : null}
      </Head>
      <Standing
        of="app"
        {...progressCells(progressOf(progressRead), {
          inProgress:
            lanesOpen === null
              ? undefined
              : `${lanesOpen.toLocaleString()} ${lanesOpen === 1 ? 'Lane' : 'Lanes'} open`,
          hrefs: { inProgress: at({ place: 'lanes' }) },
        })}
      />
      <div className="plan-body">
        <ViewsColumn
          projectId={projectId ?? ''}
          query={query}
          base={at({})}
          go={go}
          viewer={viewer}
          initiatives={initiatives}
          owners={owners}
          types={types}
          counts={counts}
        />
        <Region
          title={scopeWords[query.scope]}
          count={view ? shown : undefined}
          hint={
            view
              ? words.length
                ? words.join(', ')
                : query.sort === 'hand'
                  ? query.scope === 'closed'
                    ? 'newest first'
                    : 'in the order set by hand'
                  : `by ${query.sort}; order numbers and dragging are off`
              : undefined
          }
          tools={
            view && openShown && query.layout !== 'board' && view.groups.length > 1 ? (
              <>
                <Key size="sm" kind="ghost" disabled={allShut} onClick={() => setFolds('shut')}>
                  Collapse all
                </Key>
                <Key size="sm" kind="ghost" disabled={!anyShut} onClick={() => setFolds('open')}>
                  Expand all
                </Key>
              </>
            ) : undefined
          }
        >
          <Toolbar
            query={query}
            go={go}
            initiatives={initiatives}
            owners={owners}
            types={types}
            viewer={viewer}
            count={
              view
                ? `${shown.toLocaleString()} ${shown === 1 ? 'Item' : 'Items'}${closed.more || dropped.more || view.more ? '+' : ''}`
                : ''
            }
          />
          {selected.length && run && reads ? (
            <BulkBar
              rows={selected}
              loaded={loadedIds.length}
              initiatives={initiatives}
              parents={liveItems.filter(row => !row.parentId || !byId.has(row.parentId))}
              owners={owners}
              viewer={viewer}
              run={run}
              reads={reads}
              onDone={done}
              onSelectLoaded={() => setPicked(new Set(loadedIds.slice(0, planningBatchLimit)))}
              onClear={() => setPicked(new Set())}
            />
          ) : null}
          {stale ? (
            <div className="pf" role="status">
              Forge could not refresh the plan; these are the rows read last.
            </div>
          ) : null}
          {error ? (
            <div className="pf" role="alert">
              {error}
            </div>
          ) : null}
          {!view ? (
            <div className="quietline" aria-busy="true">
              Loading the plan…
            </div>
          ) : query.layout === 'board' ? (
            <Board
              rows={[
                ...(openShown ? view.groups.flatMap(group => group.lines.map(line => line.row)) : []),
                ...(query.scope === 'open' ? [] : settledRows),
              ]}
              sort={query.sort}
              byId={byId}
              at={at}
              ticker={ticker}
              settled={query.scope !== 'open'}
            />
          ) : (
            <>
              {openShown ? (
                <Groups
                  view={view}
                  query={query}
                  byHand={byHand}
                  at={at}
                  ticker={ticker}
                  folds={folds}
                  onToggle={toggleFold}
                  onMove={move}
                  onMoveInitiative={view.canEdit && byHand ? moveInitiative : undefined}
                />
              ) : null}
              {openShown && !view.live && !view.groups.length ? (
                <div className="quietline">No Items yet.</div>
              ) : null}
              {openShown && (find.trim() || filtered(query)) && !liveShown ? (
                <div className="quietline">
                  Nothing in open work matches{words.length ? ` (${words.join(', ')})` : ''}.
                </div>
              ) : null}
              {openShown && view.more ? (
                <div className="pf">
                  Some open Items were not read; the first {view.live.toLocaleString()} are listed.
                </div>
              ) : null}
              {openShown && view.next && !filtered(query) ? (
                <div className="plan-next">
                  <span
                    className="nextmark"
                    title="The first planned Item with no owner, no Lane and nothing blocking it, in order"
                  >
                    next
                  </span>
                  <A className="lk" href={at({ rest: view.next.id })}>
                    {view.next.title}
                  </A>
                </div>
              ) : null}
            </>
          )}
          {query.scope !== 'open' && query.layout !== 'board' ? (
            <SettledList rows={settledRows} sort={query.sort} at={at} ticker={ticker} />
          ) : null}
          {query.scope !== 'open' ? <SettledPager closed={closed} dropped={dropped} /> : null}
        </Region>
      </div>
      {captureSheet}
      {toast && run ? (
        <UndoToast
          {...toast}
          run={run}
          byId={byId}
          onGone={words => {
            setToast(null);
            if (words) announce(words);
          }}
        />
      ) : null}
      <Announcer message={message} />
    </div>
  );
}

function SettledList({
  rows,
  sort,
  at,
  ticker,
}: {
  rows: readonly PlanRow[];
  sort: PlanQuery['sort'];
  at: (patch: Partial<PlaceProps['route']>) => string;
  ticker: Ticker | undefined;
}) {
  const lines = sortRows(
    rows.map(row => ({ row })),
    sort,
  );
  return (
    <div className="grp plan-grp">
      <Band
        title="Done and dropped"
        count={rows.length}
        hint={sort === 'hand' ? 'newest first' : `by ${sort}`}
      />
      {lines.length ? (
        <div role="list" aria-label="Done and dropped Items">
          {lines.map(({ row }) => (
            <div
              role="listitem"
              key={row.id}
              className="row"
              style={{ gridTemplateColumns: `${ticker ? '28px ' : ''}${COLS}` }}
            >
              {ticker ? <Tick row={row} ticker={ticker} /> : null}
              <Line
                line={{ row, depth: 0, rank: 0, next: false }}
                href={at({ rest: row.id })}
                ranked={false}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="quietline">Nothing done or dropped matches.</div>
      )}
    </div>
  );
}

function SettledPager({ closed, dropped }: { closed: Settled; dropped: Settled }) {
  const loading = closed.loading || dropped.loading;
  const failed = closed.failed || dropped.failed;
  if (!loading && !failed && !closed.more && !dropped.more) return null;
  return (
    <div className="pager">
      <span className="n">
        {loading
          ? 'Loading done and dropped Items…'
          : failed
            ? 'A page could not be read; the rows above stay.'
            : ''}
      </span>
      {closed.more || dropped.more ? (
        <Key
          size="sm"
          onClick={() => {
            if (closed.more) closed.loadMore();
            if (dropped.more) dropped.loadMore();
          }}
        >
          Show 50 more
        </Key>
      ) : null}
    </div>
  );
}

/** An Item from the plan's own read: status, place in its Initiative, owner, done-when and relations, then its
 * comments (their own reads). Versions compare and restore in a sheet; the body opens on the current Item screen
 * until the Item page is rebuilt. */
function ItemPage({
  route,
  projectName,
  view,
  at,
  projectId,
  onSplit,
  onVersions,
  split,
  versions,
  toast,
}: {
  route: PlaceProps['route'];
  projectName: string;
  view: PlanView | null;
  at: (patch: Partial<PlaceProps['route']>) => string;
  projectId: Id<'hostedProjects'> | undefined;
  onSplit?: (() => void) | undefined;
  onVersions?: (() => void) | undefined;
  versions?: ReactNode;
  split?: ReactNode;
  toast?: ReactNode;
}) {
  const row = view
    ? ([...view.byId.values()].find(entry => entry.id.startsWith(route.rest)) ?? null)
    : undefined;
  const legacy = currentScreenHref(route);
  const full = legacy && row ? `${legacy}?planningItem=${encodeURIComponent(row.id)}` : legacy;
  const group = row
    ? view?.groups.find(entry => entry.lines.some(line => line.row.id === row.id))
    : undefined;
  const line = group?.lines.find(entry => entry.row.id === row?.id);
  const blocks = row
    ? [...view!.byId.values()].filter(other =>
        other.relations?.some(relation => relation.kind === 'depends-on' && relation.id === row.id),
      )
    : [];
  const facts: [string, ReactNode][] = row
    ? [
        ['Status', <Status key="s" row={row} />],
        [
          'In',
          group?.initiative
            ? `${group.initiative.title}${line && !line.depth ? `, ${line.rank} of ${group.lines.filter(entry => !entry.depth).length} in order` : ''}`
            : 'No Initiative',
        ],
        ['Owner', row.owner ? <Who key="o" handle={row.owner} /> : 'no one yet'],
        ['Done when', <DoneWhen key="d" row={row} />],
        ...(row.type ? ([['Type', row.type]] as [string, ReactNode][]) : []),
        ...(row.hidden ? ([['Public plan', 'hidden']] as [string, ReactNode][]) : []),
      ]
    : [];
  return (
    <div className="plan">
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          row === undefined ? (
            'Loading the Item…'
          ) : row === null ? (
            'This Item is not in open work.'
          ) : (
            <>
              <b dir="auto">{row.title}</b> {itemStatusLabel[statusOf(row)]}
              {line?.next ? ', and it is the next free one.' : '.'}
            </>
          )
        }
      >
        {row && onVersions ? (
          <Key size="sm" onClick={onVersions}>
            Versions
          </Key>
        ) : null}
        {row && onSplit && row.kind === 'issue' && row.doneWhen && row.doneWhen[1] > 1 ? (
          <Key size="sm" onClick={onSplit}>
            Split into several…
          </Key>
        ) : null}
        {full ? (
          <a className="btn sm" href={full}>
            Open the full Item
          </a>
        ) : null}
      </Head>
      {split}
      {versions}
      {toast}
      {row ? (
        <Region title="Item">
          <dl className="kv">
            {facts.map(([label, value]) => (
              <FactRow key={label} label={label}>
                {value}
              </FactRow>
            ))}
          </dl>
          {row.relations?.length || blocks.length ? (
            <>
              <Band title="Relations" count={(row.relations?.length ?? 0) + blocks.length} />
              {row.relations?.map(relation => (
                <Relation
                  key={`${relation.kind}:${relation.id}`}
                  kind={relation.kind}
                  id={relation.id}
                  view={view!}
                  at={at}
                />
              ))}
              {blocks.map(other => (
                <Row key={`blocks:${other.id}`} cols="8em minmax(0, 1fr)">
                  <span className="t2">{inverseRelationLabel['depends-on']}</span>
                  <A className="lk" href={at({ rest: other.id })} dir="auto">
                    {other.title}
                  </A>
                </Row>
              ))}
            </>
          ) : null}
          {projectId ? (
            <Suspense fallback={<div className="quietline">Loading the comments…</div>}>
              <ItemDiscussion projectId={projectId} itemId={row.id} />
            </Suspense>
          ) : null}
        </Region>
      ) : row === null ? (
        <Region title="Item">
          <div className="quietline">
            It may be done or abandoned. <A href={at({})}>Back to the plan</A>
          </div>
        </Region>
      ) : null}
    </div>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const relationWords = {
  'depends-on': 'Depends on',
  'duplicate-of': 'Duplicate of',
  related: 'Related',
} as const;
function Relation({
  kind,
  id,
  view,
  at,
}: {
  kind: keyof typeof relationWords;
  id: string;
  view: PlanView;
  at: (patch: Partial<PlaceProps['route']>) => string;
}) {
  const other = view.byId.get(id);
  return (
    <Row cols="8em minmax(0, 1fr)">
      <span className="t2">{relationWords[kind]}</span>
      {other ? (
        <A className="lk" href={at({ rest: id })} dir="auto">
          {other.title}
        </A>
      ) : (
        <span className="mono t2">{id.slice(0, 8)}, not in open work</span>
      )}
    </Row>
  );
}
