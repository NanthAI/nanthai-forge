// SPDX-License-Identifier: Apache-2.0
// Plan (Items d3357f40, b7a0dff1, e0a23825, 65b0e706): one hand-ordered list grouped by Initiative. The page sentence
// and the standing line answer what is done, in progress and left; "next" is derived from state
// (src/planning-model.ts nextItem), never stored. The view (scope, filters, order, list / tree / board, find) lives
// in the address; ticked rows change together in one batch with one Undo. Loaded with its route only.
// Reads: projectPlanView:read, one subscription, re-run only by planning writes in the ranges it read; the Closed and
// Everything scopes add one bounded page each of done and dropped Items (projectPlanSettled:page). Writes:
// projectWorkCommand:command for one row, projectPlanningBatch:apply for a selection, each retry-safe by its
// operation id.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useConvex, useMutation } from 'convex/react';
import { makeFunctionReference, type PaginationResult } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  Band,
  ItemState,
  Key,
  Region,
  ReorderList,
  Row,
  Sheet,
  Standing,
  State,
  Who,
  useFold,
} from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import {
  defaultItemTypes,
  inverseRelationLabel,
  isLive,
  itemStatusLabel,
} from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { planningBatchLimit } from '../../../../src/planning-batch';
import { useSafePaginatedQuery, useSafeQuery } from '../../safe-query';
import { A } from '../frames';
import { currentScreenHref, hrefFor } from '../paths';
import { Head, Placeholder, crumbsFor } from '../Place';
import { navigate, useSearch } from '../router';
import type { PlaceProps } from '../screens';
import { readComments, readItems, runBatch, batchApply, type BatchOutcome, type RunBatch } from './batch';
import { Board } from './Board';
import { Tick, type Ticker } from './Tick';
import { Versions } from './Versions';
import { BulkBar, SplitSheet, UndoToast, outcomeWords, type Reads } from './Bulk';
import {
  captureBody,
  matches,
  movedRank,
  planSentence,
  planView,
  statusOf,
  type PlanGroup,
  type PlanLine,
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
    paginationOpts: { cursor: string | null; numItems: number };
  },
  PaginationResult<string>
>('projectPlanSettled:page');
/** An Item's comments (Item 9a3d6f5f) load with the Item page only, so the list never loads the Markdown renderer. */
const ItemDiscussion = lazy(() => import('../discussion/ItemDiscussion'));
/** Columns after the handle: position, the name with its flags, done-when, owner, status. */
const COLS = '2.2em minmax(0, 1fr) auto auto auto';

export type Put = (command: Record<string, unknown>) => Promise<unknown>;

export default function Plan(props: PlaceProps) {
  // The Initiatives section keeps its placeholder until it is rebuilt.
  if (props.route.section) return <Placeholder route={props.route} projectName={props.projectName} />;
  return <PlanScreen {...props} />;
}

/** Done and dropped Items, a page of 50 at a time, only while the scope asks for them. */
function useSettled(projectId: Id<'hostedProjects'>, status: 'closed' | 'abandoned', on: boolean) {
  const pages = useSafePaginatedQuery(settledPage, on ? { projectId, status } : 'skip', {
    initialNumItems: 50,
  });
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
  // A failed or offline refresh keeps the last rows and the chosen view; the page says so.
  const last = useRef<PlanRead | undefined>(undefined);
  if (live.value) last.current = live.value;
  const read = live.value ?? last.current;
  const closed = useSettled(projectId, 'closed', query.scope !== 'open');
  const dropped = useSettled(projectId, 'abandoned', query.scope !== 'open');
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
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed'> & {
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
}) {
  const [orders, setOrders] = useState<ReadonlyMap<string, string>>(new Map());
  const [capture, setCapture] = useState(false);
  const [split, setSplit] = useState(false);
  const [versions, setVersions] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<{ outcome: BatchOutcome; words: string } | null>(null);
  const [message, announce] = useAnnounce();
  const find = query.find;
  const keep = useMemo(() => (row: PlanRow) => keeps(row, query), [query]);
  const view = useMemo(
    () => (read ? planView(read, find.trim(), orders, keep) : null),
    [read, find, orders, keep],
  );
  const at = (patch: Partial<PlaceProps['route']>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const canCapture = Boolean(view?.canEdit) && !route.rest;
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
  if (route.rest)
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
        done={{ n: whole?.done ?? 0, more: whole ? 'in open Initiatives' : 'loading' }}
        inProgress={{
          n: whole?.inProgress ?? 0,
          more:
            lanesOpen === null
              ? undefined
              : `${lanesOpen.toLocaleString()} ${lanesOpen === 1 ? 'Lane' : 'Lanes'} open`,
          href: at({ place: 'lanes' }),
        }}
        left={{
          n: whole ? whole.planned + whole.proposed : 0,
          more: whole
            ? [
                whole.proposed ? `${whole.proposed.toLocaleString()} proposed` : '',
                whole.more ? 'at least' : '',
              ]
                .filter(Boolean)
                .join(', ') || undefined
            : undefined,
        }}
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
              {openShown
                ? view.groups.map(group => (
                    <Group
                      key={group.initiative?.id ?? 'none'}
                      group={group}
                      view={view}
                      query={query}
                      byHand={byHand}
                      at={at}
                      ticker={ticker}
                      onMove={(id, toIndex) => move(group, id, toIndex)}
                    />
                  ))
                : null}
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
      {view?.canEdit ? (
        <Capture open={capture} onOpenChange={setCapture} view={view} put={put} announce={announce} />
      ) : null}
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

function Group({
  group,
  view,
  query,
  byHand,
  at,
  ticker,
  onMove,
}: {
  group: PlanGroup;
  view: PlanView;
  query: PlanQuery;
  byHand: boolean;
  at: (patch: Partial<PlaceProps['route']>) => string;
  ticker: Ticker | undefined;
  onMove: (id: string, toIndex: number) => void;
}) {
  const name = group.initiative?.title ?? 'No Initiative';
  const tree = query.layout === 'tree';
  const [open, toggle] = useFold(tree ? `plan.${group.initiative?.id ?? 'none'}` : undefined);
  const lines = byHand || query.sort === 'hand' ? group.lines : sortRows(group.lines, query.sort);
  const items = (tree && !open ? [] : lines).map(line => ({
    id: line.row.id,
    label: line.row.title,
    line,
  }));
  if (filtered(query) && !group.lines.length) return null;
  return (
    <div className="grp plan-grp">
      <Band
        title={name}
        count={group.live}
        hint={
          group.initiative ? (
            <span className="plan-roll">
              <Roll group={group} />
              {group.done.toLocaleString()}
              {group.atLeast ? '+' : ''} of {group.total.toLocaleString()} done
              {group.dropped ? `, ${group.dropped.toLocaleString()} dropped` : ''}
              {group.initiative.hidden ? ', hidden from the public plan' : ''}
            </span>
          ) : (
            'not in an Initiative yet'
          )
        }
      />
      {tree ? (
        <button type="button" className="btn ghost sm plan-fold" aria-expanded={open} onClick={toggle}>
          {open ? 'Fold' : `Show ${lines.length.toLocaleString()}`}
        </button>
      ) : null}
      {items.length ? (
        <ReorderList
          label={`${name}, open Items in order`}
          items={items}
          onMove={onMove}
          disabled={!view.canEdit || !byHand}
          cols={`${ticker ? '28px ' : ''}${COLS}`}
        >
          {({ line }) => (
            <>
              {ticker ? <Tick row={line.row} ticker={ticker} /> : null}
              <Line
                line={line}
                href={at({ rest: line.row.id })}
                ranked={query.sort === 'hand'}
                flat={!tree}
              />
            </>
          )}
        </ReorderList>
      ) : group.live || (tree && !open) ? null : (
        <div className="quietline">No open Items.</div>
      )}
    </div>
  );
}

/** One tick per Item: done, in progress, not started (DESIGN.md roll-up; no typed percentage). */
function Roll({ group }: { group: PlanGroup }) {
  const total = group.total;
  const ticks = Math.min(total, 40);
  const step = total / (ticks || 1);
  return (
    <span
      className="roll"
      role="img"
      aria-label={`${group.done} of ${total} done, ${group.inProgress} in progress`}
    >
      {Array.from({ length: ticks }, (_, index) => (
        <i
          key={index}
          className={
            index * step < group.done
              ? 'ok'
              : index * step < group.done + group.inProgress
                ? 'run'
                : undefined
          }
        />
      ))}
    </span>
  );
}

export function Status({ row }: { row: PlanRow }) {
  const status = statusOf(row);
  if (status === 'proposed' || status === 'planned') return <ItemState of={status} />;
  if (status === 'in-progress') return <State word="In progress" />;
  return <State word={status === 'done' ? 'Done' : 'Abandoned'} />;
}

export function DoneWhen({ row }: { row: PlanRow }) {
  if (!row.doneWhen) return <span className="dw t3">none</span>;
  const [ticked, total] = row.doneWhen;
  return (
    <span className="dw" title={`${ticked} of ${total} done-when lines ticked`}>
      {total <= 12 ? (
        <span className="shards" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <i key={index} className={index < ticked ? 'ok' : undefined} />
          ))}
        </span>
      ) : null}
      <span className="num">
        {ticked}/{total}
      </span>
    </span>
  );
}

/** One row's cells after the tick box. `ranked` is false under any order other than by hand, so no order number
 * suggests a hand order that is not shown. */
function Line({
  line,
  href,
  ranked = true,
  flat = false,
}: {
  line: PlanLine;
  href: string;
  ranked?: boolean;
  /** List layout: sub-items sit at their parent's place without the tree's indent. */
  flat?: boolean;
}) {
  const { row } = line;
  return (
    <>
      <span className="rk" aria-hidden="true">
        {line.depth || !ranked ? '' : line.rank}
      </span>
      <span className={`tt${line.depth && !flat ? ' sub' : ''}`}>
        <A className="ttl" href={href} dir="auto" title={row.title}>
          {row.title}
        </A>
        {line.next ? (
          <span
            className="nextmark"
            title="The first planned Item with no owner, no Lane and nothing blocking it"
          >
            next
          </span>
        ) : null}
        {line.blockedBy ? (
          <span className="flag" title={`Cannot start until ${line.blockedBy.title} is done`}>
            blocked by {line.blockedBy.id.slice(0, 4)}
          </span>
        ) : null}
        {row.type ? <span className="flag">{row.type}</span> : null}
        {row.hidden ? <span className="flag">hidden</span> : null}
      </span>
      <span className="plan-wide">
        <DoneWhen row={row} />
      </span>
      <span className="plan-wide">
        {row.owner ? <Who handle={row.owner} /> : <span className="t3">no one yet</span>}
      </span>
      <span className="state">
        <Status row={row} />
      </span>
    </>
  );
}

/** New Item: a person's Item starts Planned (owner decision 1.3) and lands last in its group, since its creation
 * position sorts after every stored rank. Matching open Items are shown while typing. */
function Capture({
  open,
  onOpenChange,
  view,
  put,
  announce,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: PlanView;
  put: Put;
  announce: (text: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [initiativeId, setInitiativeId] = useState('');
  const [type, setType] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One operation per Item written here, so a retry after a lost reply never files it twice.
  const pending = useRef<{ itemId: string; key: string } | null>(null);
  const initiatives = view.groups.flatMap(group => (group.initiative ? [group.initiative] : []));
  const similar =
    title.trim().length >= 3
      ? [...view.byId.values()].filter(row => row.kind === 'issue' && matches(row, title.trim())).slice(0, 3)
      : [];
  const reset = () => {
    setTitle('');
    setDoneWhen('');
    setType('');
    setError('');
    pending.current = null;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    const key = JSON.stringify([text, initiativeId, type, doneWhen]);
    if (pending.current?.key !== key) pending.current = { itemId: crypto.randomUUID(), key };
    setBusy(true);
    setError('');
    try {
      await put({
        itemId: pending.current.itemId,
        expectedVersion: 0,
        kind: 'issue',
        title: text,
        body: captureBody(doneWhen),
        status: 'open',
        initiativeId: initiativeId || null,
        ...(type ? { type } : {}),
      });
      announce(`${text} planned.`);
      reset();
      onOpenChange(false);
    } catch {
      setError('Forge could not file it. Nothing was filed; try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="New Item"
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-capture" disabled={!title.trim() || busy}>
            {busy ? 'Filing…' : 'Plan it'}
          </Key>
        </>
      }
    >
      <form id="plan-capture" className="plan-capture" onSubmit={submit}>
        <label>
          <span>Title</span>
          <input
            className="inp"
            value={title}
            onChange={event => setTitle(event.target.value)}
            required
            autoFocus
          />
        </label>
        {similar.length ? (
          <div className="plan-similar" role="status">
            <span className="t2">Already in open work:</span>
            {similar.map(row => (
              <span key={row.id} className="cut" dir="auto">
                {row.title}
              </span>
            ))}
          </div>
        ) : null}
        <label>
          <span>Initiative</span>
          <select
            className="inp"
            value={initiativeId}
            onChange={event => setInitiativeId(event.target.value)}
          >
            <option value="">No Initiative</option>
            {initiatives.map(row => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select className="inp" value={type} onChange={event => setType(event.target.value)}>
            <option value="">None</option>
            {defaultItemTypes.map(name => (
              <option key={name} value={name}>
                {name[0]!.toUpperCase() + name.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Done when (one line each)</span>
          <textarea
            className="inp"
            rows={3}
            value={doneWhen}
            onChange={event => setDoneWhen(event.target.value)}
          />
        </label>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
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
