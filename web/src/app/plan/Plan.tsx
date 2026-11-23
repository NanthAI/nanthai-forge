// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Plan (Items d3357f40, b7a0dff1, e0a23825, 65b0e706): one hand-ordered list grouped by Initiative. The page sentence
// and the standing line answer what is done, in progress and left; "next" is derived from state
// (src/planning-model.ts nextItem), never stored. The view (scope, filters, order, list / tree / board, find) lives
// in the address; ticked rows change together in one batch with one Undo. Loaded with its route only.
// Reads: projectPlanView:read, one subscription, re-run only by planning writes in the ranges it read; the Closed and
// Everything scopes add one bounded page each of done and dropped Items, and the Archive and Deleted views one page of
// theirs (projectPlanSettled:page); who works on an unowned Item is one bounded one-shot read by Intent
// (projectPlanWorkers:read, workers.ts), again only when the in-progress Items change or a hidden tab is shown again.
// Item links outside the open plan use an exact lookup (projectPlanSettled:item). Owners can also open shelved Items.
// Writes:
// projectWorkCommand:command for one row, projectPlanningBatch:apply for a selection, each retry-safe by its
// operation id.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAction, useConvex, useMutation } from 'convex/react';
import { makeFunctionReference, type PaginationResult } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, Key, Menu, Region, Standing } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { isLive, itemStatus, itemStatusLabel } from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { planningBatchLimit } from '../../../../src/planning-batch';
import { useSafePaginatedQuery, useSafeQuery } from '../../safe-query';
import { usePageCritical } from '../../ui/page-critical';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import { progressCells, progressOf, type PlanCountsRead } from '../progress';
import { navigate, useSearch } from '../router';
import type { PlaceProps } from '../screens';
import {
  readComments,
  readInitiative,
  readItems,
  runBatch,
  batchApply,
  type BatchOutcome,
  type RunBatch,
} from './batch';
import { boardBands, planBands } from './bands';
import { Board, BoardLoading, FieldList } from './Board';
import { Capture } from './Capture';
import { isShut, NO_INITIATIVE, usePlanFolds } from './fold';
import { Groups } from './Groups';
import { InitiativePage } from './Initiative';
import type { ReadInitiativeWork } from './InitiativeWork';
import { COLS, DoneWhen, Line, Owner, Status } from './rows';
import { useWorkers, type ActiveLane, type Workers } from './workers';
import { itemLanes, lanesNeedingYou } from './lane-words';
import type { NeedsRead } from '../needs/count';
import { mainToday } from '../../../../src/flow-day';
import { Tick, type Ticker } from './Tick';
import { Versions } from './Versions';
import { isShelf, shelfWords, shelve, ShelfList, unshelve, type Shelf } from './Shelf';
import { isPlanningPrefix, isPlanningUuid } from '../../../../src/planning-id';
import { DeleteForever, type PurgeItem } from './DeleteForever';
import type { BatchPut } from '../../../../src/planning-batch';
import { BulkBar, SplitSheet, UndoToast, outcomeWords, type Reads } from './Bulk';
import {
  matches,
  movedInitiativeRank,
  movedRank,
  planSentence,
  parseRows,
  planView,
  statusOf,
  type PlanGroup,
  type PlanRead,
  type PlanView,
} from './model';
import { filtered, keeps, readQuery, sortRows, writeQuery, type PlanQuery } from './query';
import { Toolbar } from './Views';
import { useProjectPages } from '../project-pages';
import { ItemWork, type ReadItemWork } from './ItemWork';
import './plan.css';

const planRead = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; observeClose?: string },
  PlanRead
>('projectPlanView:read');
/** Open Lanes active in the last 48 hours (convex/projectPlanWorkers.ts), read once, never subscribed. */
const planWorkers = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; intentIds: string[] },
  string
>('projectPlanWorkers:read');
const settledPage = makeFunctionReference<
  'query',
  {
    projectId: Id<'hostedProjects'>;
    status: 'closed' | 'abandoned' | Shelf;
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
  status: 'closed' | 'abandoned' | Shelf,
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

function PlanScreen({ route, projectId, projectName, feed, viewerHandle, needsRead }: PlaceProps) {
  const search = useSearch();
  const query = useMemo(() => readQuery(search), [search.toString()]);
  const [observeClose, setObserveClose] = useState<string>();
  const live = useSafeQuery(planRead, { projectId, ...(observeClose ? { observeClose } : {}) });
  const counts = useSafeQuery(api.projectPlanCounts.read, { projectId });
  usePageCritical('Plan', {
    plan: live.value !== undefined,
    planCounts: counts.value !== undefined,
  });
  // A failed or offline refresh keeps the last rows and the chosen view; the page says so.
  const last = useRef<PlanRead | undefined>(undefined);
  if (live.value) last.current = live.value;
  const read = live.value ?? last.current;
  // An Initiative page asks for its own done and dropped Items while that fold is open.
  const [doneFor, showDone] = useState<string | null>(null);
  const settledOn = query.scope === 'closed' || query.scope === 'all' || doneFor !== null;
  const settledIn = doneFor ?? query.initiative;
  const closed = useSettled(projectId, 'closed', settledOn, settledIn);
  const dropped = useSettled(projectId, 'abandoned', settledOn, settledIn);
  const shelfScope = isShelf(query.scope) ? query.scope : null;
  const shelved = useSettled(projectId, shelfScope ?? 'archived', shelfScope !== null, undefined);
  // A short link must resolve across both the open plan and the shelves before a row can be selected.
  const lookupId = route.rest.toLowerCase();
  const shortLink = Boolean(read?.canEdit && isPlanningPrefix(lookupId));
  const lookup = useMemo(
    () =>
      shortLink || (read && isPlanningUuid(lookupId) && !parseRows(read).some(row => row.id === lookupId)),
    [shortLink, read, lookupId],
  );
  const linked = useSafeQuery(api.projectPlanSettled.item, lookup ? { projectId, id: lookupId } : 'skip');
  const linkedItem = useMemo(
    () =>
      lookup && !linked.error && linked.value === undefined
        ? ('loading' as const)
        : linked.value?.row
          ? (JSON.parse(linked.value.row) as PlanRow)
          : null,
    [lookup, linked.error, linked.value],
  );
  const mutate = useMutation(api.projectWorkCommand.command);
  const deleteForever = useAction(api.projectItemRetention.deleteForever);
  const apply = useMutation(batchApply);
  const client = useConvex();
  const readItemWork = useCallback<ReadItemWork>(
    (itemId, cursor) =>
      client.query(api.projectItemWork.read, { projectId, itemId, limit: 10, cursor, details: true }),
    [client, projectId],
  );
  const readInitiativeWork = useCallback<ReadInitiativeWork>(
    initiativeId => client.query(api.projectInitiativeWork.read, { projectId, initiativeId }),
    [client, projectId],
  );
  const put: Put = command => {
    const operationId = crypto.randomUUID();
    return mutate({
      projectId,
      operationId,
      command: JSON.stringify({ action: 'put-planning-item', operationId, ...command }),
    });
  };
  const run: RunBatch = async (writes, options) => {
    const result = await runBatch(apply, projectId, writes, options);
    setObserveClose(result.pendingOperation);
    return result;
  };
  const reads: Reads = {
    items: ids => readItems(client, projectId, ids),
    initiative: id => readInitiative(client, projectId, id),
    comments: ids => readComments(client, projectId, ids),
    workers: async intentIds => {
      const reply = JSON.parse(await client.query(planWorkers, { projectId, intentIds: [...intentIds] })) as {
        lanes?: ActiveLane[];
        withheld?: boolean;
      };
      return { lanes: Array.isArray(reply.lanes) ? reply.lanes : [], withheld: reply.withheld === true };
    },
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
      needs={needsRead}
      read={read}
      stale={Boolean(live.error) && Boolean(last.current)}
      put={put}
      run={run}
      purge={input => deleteForever({ projectId, ...input })}
      reads={reads}
      readItemWork={readItemWork}
      readInitiativeWork={readInitiativeWork}
      query={query}
      go={go}
      viewer={viewerHandle}
      closed={closed}
      dropped={dropped}
      shelved={shelved}
      linkedItem={linkedItem}
      resolvedShortId={shortLink ? (linked.value?.id ?? null) : undefined}
      showDone={showDone}
      progress={counts.error ? null : counts.value}
      clearCloseObservation={() => setObserveClose(undefined)}
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
const scopeWords = {
  open: 'Open work',
  closed: 'Done and dropped',
  all: 'Everything',
  archived: 'Archive',
  deleted: 'Deleted',
} as const;
/** What an agent runs for the same Items (the chip beside New Item). */
const planCommand = `nforge agent . planning '{"status":"open"}'`;
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
  purge,
  reads,
  readItemWork,
  readInitiativeWork,
  query = readQuery(new URLSearchParams()),
  go = () => undefined,
  viewer,
  closed = noSettled,
  dropped = noSettled,
  shelved = noSettled,
  linkedItem = null,
  shelvedItem = null,
  resolvedShortId,
  showDone = () => undefined,
  progress: progressRead,
  clearCloseObservation,
  needs,
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed'> & {
  /** The shell's Needs me read (App.tsx), already held: which Lanes wait on the reader, for the board's state words. */
  needs?: NeedsRead | undefined;
  /** The project's progress counts (convex/projectPlanCounts.ts), the same read Needs me shows; null when the read
   * gave none (failed, or no counts), and then the strip is not drawn rather than say "not reported" three times. */
  progress?: PlanCountsRead | null | undefined;
  clearCloseObservation?: () => void;
  /** The Item resolved by a direct link outside the open Plan. */
  linkedItem?: PlanRow | null | 'loading';
  shelvedItem?: PlanRow | null | 'loading';
  resolvedShortId?: string | null | undefined;
  /** Hosted reads for the Item page's comments and versions; without it the page draws neither. */
  projectId?: Id<'hostedProjects'> | undefined;
  read: PlanRead | undefined;
  stale?: boolean;
  put: Put;
  run?: RunBatch;
  purge?: PurgeItem;
  reads?: Reads;
  readItemWork?: ReadItemWork | undefined;
  readInitiativeWork?: ReadInitiativeWork | undefined;
  query?: PlanQuery;
  go?: (patch: Partial<PlanQuery>) => void;
  viewer?: string | undefined;
  closed?: Settled;
  dropped?: Settled;
  /** The Archive or Deleted view's rows, read only while that view is open. */
  shelved?: Settled;
  /** The Initiative page's done and dropped fold: subscribe for one Initiative, or drop it (null). */
  showDone?: (initiativeId: string | null) => void;
}) {
  const [orders, setOrders] = useState<ReadonlyMap<string, string>>(new Map());
  const [capture, setCapture] = useState(false);
  const [split, setSplit] = useState(false);
  const [versions, setVersions] = useState(false);
  const [purging, setPurging] = useState<PlanRow | null>(null);
  const [error, setError] = useState('');
  const [cli, setCli] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<{ outcome: BatchOutcome; words: string } | null>(null);
  // The Item just archived or deleted from its page, so the page can say where it went and bring it back.
  const [sent, setSent] = useState<{ row: PlanRow; shelf: Shelf; version: number } | null>(null);
  const [message, announce] = useAnnounce();
  const { folds, toggle: toggleFold, setAll: setFolds } = usePlanFolds(projectId ?? '');
  const navigation = useProjectPages();
  const setRailCounts = navigation?.setCounts;
  const find = query.find;
  const keep = useMemo(() => (row: PlanRow) => keeps(row, query), [query]);
  const view = useMemo(
    () => (read ? planView(read, find.trim(), orders, keep) : null),
    [read, find, orders, keep],
  );
  const at = (patch: Partial<PlaceProps['route']>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const itemKey = resolvedShortId === undefined ? route.rest.toLowerCase() : resolvedShortId;
  const initiativeRow = itemKey
    ? [...(view?.byId.values() ?? [])].find(
        entry => entry.kind === 'initiative' && entry.id.startsWith(itemKey),
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
  const allRows = useMemo(() => (whole ? [...whole.byId.values()] : undefined), [whole]);
  const selectedInitiative = initiativeRow?.id;
  const workerRows = useMemo(
    () =>
      selectedInitiative
        ? (whole?.groups.find(group => group.initiative?.id === selectedInitiative)?.lines ?? []).map(
            line => line.row,
          )
        : allRows,
    [whole, allRows, selectedInitiative],
  );
  const {
    byItem: workers,
    observedLanes,
    missingIdentity,
    lanes: workerLanes,
    asked: workerAsked,
  } = useWorkers(reads?.workers, workerRows, Boolean(selectedInitiative));
  // Each working Item's Lane state from reads already held (lane-words.ts): no read of its own.
  const lanes = useMemo(
    () => itemLanes({ asked: workerAsked, needs, feed, lanes: workerLanes, now: Date.now() }),
    [workerAsked, needs, feed, workerLanes],
  );
  const settledRows = useMemo(
    () =>
      [...closed.rows, ...dropped.rows].filter(
        row => row.kind === 'issue' && keep(row) && (!find.trim() || matches(row, find.trim())),
      ),
    [closed.rows, dropped.rows, keep, find],
  );
  const byId = useMemo(() => {
    const map = new Map(view?.byId ?? []);
    for (const row of [...closed.rows, ...dropped.rows, ...shelved.rows]) map.set(row.id, row);
    if (sent) map.set(sent.row.id, sent.row);
    return map;
  }, [view, closed.rows, dropped.rows, shelved.rows, sent]);
  const viewCounts = useMemo(() => {
    if (!whole || !allRows) return undefined;
    const me = viewer?.replace(/^@/, '');
    let mine = 0;
    let unowned = 0;
    for (const row of allRows) {
      if (row.kind !== 'issue' || !isLive(row)) continue;
      if (!row.owner) unowned++;
      if (me && ownerOf(row.owner) === me) mine++;
    }
    return { open: whole.live, mine, unowned };
  }, [allRows, viewer, whole]);
  useEffect(() => {
    setRailCounts?.(viewCounts);
    return () => setRailCounts?.(undefined);
  }, [setRailCounts, viewCounts]);
  /** One Item to a shelf or back, through the batch call: retry-safe, one version, and the 10-second Undo. */
  const shelfMove = async (writes: BatchPut[], row: PlanRow, to: Shelf | null) => {
    if (!run) return;
    setError('');
    try {
      const outcome = await run(writes);
      const applied = outcome.results.find(result => result.outcome !== 'refused');
      setSent(to && applied?.version ? { row, shelf: to, version: applied.version } : null);
      const text = to && applied ? `${shelfWords[to].done} “${row.title}”.` : outcomeWords(outcome, byId);
      setToast({ outcome, words: text });
      announce(text);
    } catch {
      setError(`Forge could not change ${row.title}; nothing changed.`);
    }
  };
  const lookedUpShelf =
    linkedItem && linkedItem !== 'loading' && isShelf(linkedItem.status) ? linkedItem : null;
  const shelfRow = lookedUpShelf ?? shelvedItem;
  const itemRow = itemKey
    ? (whole?.byId.get(itemKey) ??
      (isPlanningPrefix(itemKey)
        ? [...(whole?.byId.values() ?? [])].find(entry => entry.id.startsWith(itemKey))
        : undefined) ??
      (linkedItem && linkedItem !== 'loading' && linkedItem.id === itemKey && !isShelf(linkedItem.status)
        ? linkedItem
        : null))
    : null;
  const here =
    itemKey &&
    shelfRow &&
    shelfRow !== 'loading' &&
    shelfRow.id.startsWith(itemKey) &&
    isShelf(shelfRow.status)
      ? { row: shelfRow, shelf: shelfRow.status, back: unshelve(shelfRow) }
      : itemKey && sent && sent.row.id.startsWith(itemKey)
        ? {
            row: sent.row,
            shelf: sent.shelf,
            back: unshelve({ ...sent.row, version: sent.version, was: sent.row.status }),
          }
        : null;
  const purgeDialog =
    whole?.canEdit && purging && purge ? (
      <DeleteForever
        row={purging}
        purge={purge}
        close={() => setPurging(null)}
        onDone={() => {
          setPurging(null);
          setSent(current => (current?.row.id === purging.id ? null : current));
          setToast(current =>
            current?.outcome.results.length === 1 && current.outcome.results[0]?.itemId === purging.id
              ? null
              : current,
          );
          announce('Item deleted permanently.');
        }}
      />
    ) : null;
  if (route.rest && !initiativeRow)
    return (
      <ItemPage
        route={route}
        row={whole && (linkedItem !== 'loading' || here) ? itemRow : undefined}
        projectName={projectName}
        view={whole}
        workers={workers}
        at={at}
        projectId={projectId}
        readItemWork={readItemWork}
        onSplit={whole?.canEdit && reads && run ? () => setSplit(true) : undefined}
        onVersions={projectId ? () => setVersions(true) : undefined}
        onShelve={whole?.canEdit && run ? (row, to) => void shelfMove(shelve([row], to), row, to) : undefined}
        shelved={here}
        onBack={here && run ? () => void shelfMove([here.back], here.row, null) : undefined}
        onPurge={
          whole?.canEdit && here?.shelf === 'deleted' && purge
            ? () => setPurging({ ...here.row, version: here.back.expectedVersion })
            : undefined
        }
        purgeDialog={purgeDialog}
        announcement={<Announcer message={message} />}
        error={error}
        versions={
          versions && projectId ? (
            <Versions
              projectId={projectId}
              itemId={here?.row.id ?? itemRow?.id ?? route.rest}
              restore={
                whole?.canEdit && run
                  ? async (writes, words) => {
                      const outcome = await run(writes);
                      const text = outcome.results.some(result => result.outcome === 'refused')
                        ? outcomeWords(outcome, byId)
                        : words;
                      setToast({ outcome, words: text });
                      announce(text);
                      return outcome;
                    }
                  : undefined
              }
              onOpenChange={setVersions}
            />
          ) : null
        }
        split={
          split && reads && run ? (
            <SplitSheet
              onOpenChange={setSplit}
              row={
                itemRow ?? {
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
              key={toast.outcome.undoClose}
              {...toast}
              run={run}
              byId={byId}
              closeReceipt={read?.closeReceipt}
              onGone={words => {
                clearCloseObservation?.();
                setToast(null);
                if (words) announce(words);
              }}
            />
          ) : null
        }
      />
    );
  const progress = progressOf(progressRead ?? undefined);
  const waiting = lanesNeedingYou(needs, Date.now());
  const waitOnYou = view
    ? [...lanes].filter(([id, lane]) => lane.you && view.byId.get(id)?.status === 'in-progress').length
    : 0;
  // The join covers the Items the workers read asks about (at most 50) and the Needs me read's first page.
  const askedItems = new Set(workerAsked?.values() ?? []);
  const waitAtLeast =
    Boolean(waiting?.atLeast) ||
    (view
      ? [...view.byId.values()].some(
          row => row.kind === 'issue' && row.status === 'in-progress' && !askedItems.has(row.id),
        )
      : false);
  const sentence = view
    ? planSentence(
        view,
        progress
          ? {
              left: progress.left,
              inProgress: progress.inProgress,
              atLeast: progress.atLeast,
              waitOnYou,
              waitAtLeast,
            }
          : null,
      )
    : null;
  const lanesOpen = feed ? feed.lanes.length + feed.more : null;
  const landedToday = feed?.flow ? mainToday(feed.flow, Date.now()).landed : null;
  const byHand = query.sort === 'hand' && !filtered(query);
  const shelfScope = isShelf(query.scope) ? query.scope : null;
  const openShown = query.scope === 'open' || query.scope === 'all';
  const settledShown = query.scope === 'closed' || query.scope === 'all';
  const shelfRows = shelfScope
    ? shelved.rows.filter(row => keep(row) && (!find.trim() || matches(row, find.trim())))
    : [];
  const liveShown = view ? view.groups.reduce((sum, group) => sum + group.lines.length, 0) : 0;
  const hideEmpty = filtered(query) || !openShown;
  // Group by a field (d3357f40): the list's bands and the board's, from the same rows plus done and dropped ones.
  const listBands =
    view && query.layout !== 'board' && query.group !== 'initiative' && !shelfScope
      ? planBands(view, query.group, settledShown ? settledRows : [], { openShown, hideEmpty })
      : null;
  const board =
    view && query.layout === 'board' && !shelfScope
      ? boardBands(planBands(view, query.group, settledShown ? settledRows : [], { openShown, hideEmpty }))
      : null;
  const boardRows = board ? board.reduce((sum, band) => sum + band.lines.length, 0) : 0;
  const shown = board
    ? boardRows
    : (openShown ? liveShown : 0) + (settledShown ? settledRows.length : 0) + shelfRows.length;
  // The board's one way to make the first Item is the key in its empty region (rendered review a36cae1d).
  const boardEmpty = Boolean(board && openShown && view && !view.live && !boardRows && !filtered(query));
  const loadedIds = [
    ...(openShown && view ? view.groups.flatMap(group => group.lines.map(line => line.row.id)) : []),
    ...(settledShown ? settledRows.map(row => row.id) : []),
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
          key={initiativeRow.id}
          route={route}
          projectName={projectName}
          initiative={initiativeRow}
          view={whole}
          workers={workers}
          observedLanes={observedLanes}
          missingIdentity={missingIdentity}
          at={at}
          put={put}
          reads={reads}
          readWork={readInitiativeWork}
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
  const foldIds = listBands
    ? query.group === 'none'
      ? []
      : listBands.map(band => band.id)
    : (view?.groups ?? []).map(group => group.initiative?.id ?? NO_INITIATIVE);
  const allShut = Boolean(foldIds.length) && foldIds.every(id => isShut(folds, id));
  const anyShut = foldIds.some(id => isShut(folds, id));
  /** Collapse all and Expand all: quiet in the region's head on a desk, solid keys in the phone's sheet. */
  const foldKeys = (kind?: 'ghost') =>
    view && openShown && query.layout !== 'board' && foldIds.length > 1 ? (
      <>
        <Key size="sm" kind={kind} disabled={allShut} onClick={() => setFolds('shut')}>
          Collapse all
        </Key>
        <Key size="sm" kind={kind} disabled={!anyShut} onClick={() => setFolds('open')}>
          Expand all
        </Key>
      </>
    ) : undefined;
  const done = (outcome: BatchOutcome, extra: string) => {
    const text = [outcomeWords(outcome, byId), extra].filter(Boolean).join(' ');
    // Rows that changed leave the selection; refused rows stay ticked so they can be tried again.
    setPicked(
      new Set(outcome.results.filter(result => result.outcome === 'refused').map(result => result.itemId)),
    );
    setToast({ outcome, words: text });
    announce(text);
  };
  const currentView = navigation?.pages.plan.find(page => page.current);
  const trail = crumbsFor(route, projectName);
  if (currentView) {
    trail.at(-1)!.href = at({});
    trail.push({ label: currentView.label });
  }

  return (
    <div className="plan plan-with-views">
      <Head
        trail={trail}
        sentence={
          // An empty board says only that (mock 02-plan-board, rendered review 2026-11-19); its one key is below.
          boardEmpty ? (
            <b>Nothing is planned yet.</b>
          ) : sentence ? (
            <>
              <b>{sentence.bold}</b> {sentence.rest}
            </>
          ) : (
            'The plan.'
          )
        }
      >
        {view?.canEdit && !boardEmpty ? (
          <Key size="sm" keys="n" onClick={() => setCapture(true)}>
            New Item
          </Key>
        ) : null}
        <button
          type="button"
          className="cli mono"
          aria-controls="plan-cli"
          aria-expanded={cli}
          title="What an agent gets"
          onClick={() => setCli(open => !open)}
        >
          <span>{planCommand}</span>
        </button>
      </Head>
      {cli ? (
        <pre className="cli-out mono" id="plan-cli">
          <b>$ {planCommand}</b>
          {'\n'}The same Items as a list, in plan order. The board is a view of it, read by status; an agent
          moves an Item with put-planning-item (status).
        </pre>
      ) : null}
      {boardEmpty || progressRead === null ? null : (
        <Standing
          of="app"
          {...progressCells(progress, {
            done: landedToday === null ? undefined : `${landedToday.toLocaleString()} landed today`,
            inProgress:
              lanesOpen === null
                ? undefined
                : `${lanesOpen.toLocaleString()}${feed?.moreIsLowerBound ? '+' : ''} ${lanesOpen === 1 && !feed?.moreIsLowerBound ? 'Lane' : 'Lanes'} open${
                    waiting?.n ? `, ${waiting.n.toLocaleString()}${waiting.atLeast ? '+' : ''} need you` : ''
                  }`,
            left: view?.next ? `next: ${view.next.title}` : undefined,
            hrefs: { inProgress: at({ place: 'lanes' }) },
          })}
        />
      )}
      <div className="plan-body">
        <Region
          title={scopeWords[query.scope]}
          count={view ? shown : undefined}
          hint={
            view
              ? words.length
                ? words.join(', ')
                : query.sort === 'hand'
                  ? query.scope !== 'open' && query.scope !== 'all'
                    ? 'newest first'
                    : 'in the order set by hand'
                  : `by ${query.sort}; order numbers and dragging are off`
              : undefined
          }
          tools={foldKeys('ghost')}
        >
          <Toolbar
            query={query}
            go={go}
            initiatives={initiatives}
            owners={owners}
            types={types}
            viewer={viewer}
            projectId={projectId ?? ''}
            base={at({})}
            counts={viewCounts}
            folds={foldKeys()}
            count={
              view
                ? `${shown.toLocaleString()} ${shown === 1 ? 'Item' : 'Items'}${closed.more || dropped.more || shelved.more || view.more ? '+' : ''}`
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
            query.layout === 'board' && !isShelf(query.scope) ? (
              <BoardLoading settled={settledShown} />
            ) : (
              <div className="quietline" aria-busy="true">
                Loading the plan…
              </div>
            )
          ) : shelfScope ? (
            <ShelfList
              shelf={shelfScope}
              rows={shelfRows}
              at={at}
              run={canEdit ? run : undefined}
              onPurge={whole?.canEdit && shelfScope === 'deleted' && purge ? setPurging : undefined}
              onDone={done}
            />
          ) : board ? (
            boardEmpty ? (
              <div className="empty">
                <h3>Nothing is planned yet</h3>
                <p>Items appear here as they are added, by you or by an agent. A title is enough to start.</p>
                {view.canEdit ? (
                  <Key kind="primary" onClick={() => setCapture(true)}>
                    New Item
                  </Key>
                ) : null}
              </div>
            ) : (find.trim() || filtered(query)) && !boardRows ? (
              <div className="quietline plan-nomatch">
                No Item matches <b>{words.join(', ')}</b>.{' '}
                <A
                  className="lk"
                  href={
                    at({}) +
                    writeQuery({
                      scope: query.scope,
                      sort: query.sort,
                      layout: query.layout,
                      group: query.group,
                    })
                  }
                >
                  Clear the filter
                </A>
              </div>
            ) : (
              <Board
                bands={board}
                sort={query.sort}
                at={at}
                folds={folds}
                onToggle={toggleFold}
                settled={settledShown}
                liveAtLeast={openShown && view.more}
                settledAtLeast={{
                  done: closed.more || closed.loading || closed.failed,
                  abandoned: dropped.more || dropped.loading || dropped.failed,
                }}
                workers={workers}
                lanes={lanes}
                loaded={byId}
                ticker={ticker}
              />
            )
          ) : (
            <>
              {listBands ? (
                <FieldList
                  bands={listBands}
                  sort={query.sort}
                  at={at}
                  ticker={ticker}
                  folds={folds}
                  onToggle={toggleFold}
                  workers={workers}
                  tree={query.layout === 'tree'}
                  liveAtLeast={openShown && view.more}
                  settledRead={settledShown}
                />
              ) : openShown ? (
                <Groups
                  view={view}
                  query={query}
                  byHand={byHand}
                  at={at}
                  ticker={ticker}
                  folds={folds}
                  workers={workers}
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
          {settledShown && query.layout !== 'board' && !listBands ? (
            <SettledList rows={settledRows} sort={query.sort} at={at} ticker={ticker} />
          ) : null}
          {settledShown ? <SettledPager closed={closed} dropped={dropped} /> : null}
          {shelfScope ? (
            <SettledPager
              closed={shelved}
              dropped={noSettled}
              what={shelfWords[shelfScope].done.toLowerCase()}
            />
          ) : null}
        </Region>
      </div>
      {captureSheet}
      {purgeDialog}
      {toast && run ? (
        <UndoToast
          key={toast.outcome.undoClose}
          {...toast}
          run={run}
          byId={byId}
          closeReceipt={read?.closeReceipt}
          onGone={words => {
            clearCloseObservation?.();
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

function SettledPager({
  closed,
  dropped,
  what = 'done and dropped',
}: {
  closed: Settled;
  dropped: Settled;
  what?: string;
}) {
  const loading = closed.loading || dropped.loading;
  const failed = closed.failed || dropped.failed;
  if (!loading && !failed && !closed.more && !dropped.more) return null;
  return (
    <div className="pager">
      <span className="n">
        {loading ? `Loading ${what} Items…` : failed ? 'A page could not be read; the rows above stay.' : ''}
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
 * comments (their own reads). Versions compare and restore in a sheet. */
function ItemPage({
  route,
  row,
  projectName,
  view,
  workers,
  at,
  projectId,
  readItemWork,
  onSplit,
  onVersions,
  onShelve,
  shelved,
  onBack,
  onPurge,
  purgeDialog,
  announcement,
  error,
  split,
  versions,
  toast,
}: {
  route: PlaceProps['route'];
  row: PlanRow | null | undefined;
  projectName: string;
  view: PlanView | null;
  workers: Workers;
  at: (patch: Partial<PlaceProps['route']>) => string;
  projectId: Id<'hostedProjects'> | undefined;
  readItemWork?: ReadItemWork | undefined;
  onSplit?: (() => void) | undefined;
  onVersions?: (() => void) | undefined;
  /** Archive or Delete this Item (the owner only). */
  onShelve?: ((row: PlanRow, to: Shelf) => void) | undefined;
  /** This page's Item when it is Archived or Deleted (just sent, or opened by its link); onBack brings it back. */
  shelved?: { row: PlanRow; shelf: Shelf } | null;
  onBack?: (() => void) | undefined;
  onPurge?: (() => void) | undefined;
  purgeDialog?: ReactNode;
  announcement?: ReactNode;
  error?: string;
  versions?: ReactNode;
  split?: ReactNode;
  toast?: ReactNode;
}) {
  const workItem = row?.id ?? (row === null ? shelved?.row.id : undefined);
  const group = row
    ? view?.groups.find(entry => entry.lines.some(line => line.row.id === row.id))
    : undefined;
  const line = group?.lines.find(entry => entry.row.id === row?.id);
  const initiative = row?.initiativeId ? view?.byId.get(row.initiativeId) : undefined;
  const facts: [string, ReactNode][] = row
    ? [
        ['Status', <Status key="s" row={row} />],
        [
          'In',
          initiative
            ? `${initiative.title}${line && !line.depth && group ? `, ${line.rank} of ${group.lines.filter(entry => !entry.depth).length} in order` : ''}`
            : 'No Initiative',
        ],
        ['Owner', <Owner key="o" owner={row.owner} workers={workers.get(row.id)} />],
        ['Done when', row.doneWhen ? <DoneWhen key="d" row={row} /> : 'no checklist'],
        ...(row.type ? ([['Type', row.type]] as [string, ReactNode][]) : []),
        ...(row.hidden ? ([['Public plan', 'hidden']] as [string, ReactNode][]) : []),
      ]
    : [];
  return (
    <div className="plan">
      <Head
        trail={[
          ...crumbsFor({ ...route, rest: '' }, projectName).map(crumb =>
            initiative && !crumb.href ? { ...crumb, href: at({}) } : crumb,
          ),
          ...(initiative ? [{ label: initiative.title, href: at({ rest: initiative.id }) }] : []),
        ]}
        sentence={
          row === undefined ? (
            'Loading the Item…'
          ) : row === null && shelved ? (
            <>
              <b dir="auto">{shelved.row.title}</b> {shelfWords[shelved.shelf].done}.
            </>
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
        {row === null && shelved && onBack ? (
          <Menu
            label="More actions"
            className="btn ghost sm"
            items={[
              { id: 'back', label: shelfWords[shelved.shelf].back, onAction: onBack },
              ...(onPurge ? [{ id: 'purge', label: 'Delete forever', danger: true, onAction: onPurge }] : []),
            ]}
          >
            ⋯
          </Menu>
        ) : row && onShelve && row.kind === 'issue' ? (
          <Menu
            label="More actions"
            className="btn ghost sm"
            items={(['archived', 'deleted'] as const).map(to => ({
              id: to,
              label: shelfWords[to].send,
              onAction: () => onShelve(row, to),
            }))}
          >
            ⋯
          </Menu>
        ) : null}
      </Head>
      {error ? (
        <div className="pf" role="alert">
          {error}
        </div>
      ) : null}
      {purgeDialog}
      {announcement}
      {split}
      {versions}
      {toast}
      {row ? (
        <Region title="Item">
          <div className="plan-item-cols">
            <dl className="kv">
              {facts.map(([label, value]) => (
                <FactRow key={label} label={label}>
                  {value}
                </FactRow>
              ))}
            </dl>
            {projectId ? (
              <Suspense fallback={<div className="quietline">Loading the comments…</div>}>
                <ItemDiscussion key={row.id} projectId={projectId} itemId={row.id} project={route} />
              </Suspense>
            ) : null}
          </div>
        </Region>
      ) : row === null && shelved ? (
        <Region title="Item">
          <div className="quietline" role="status">
            <b dir="auto">{shelved.row.title}</b> is {shelfWords[shelved.shelf].done.toLowerCase()}
            {shelved.row.was ? `, was ${itemStatusLabel[itemStatus[shelved.row.was]]}` : ''}: out of every
            view, count and agent list. Its Lanes, landings and comments stay.{' '}
            {onBack ? (
              <Key size="sm" onClick={onBack}>
                {shelfWords[shelved.shelf].back}
              </Key>
            ) : null}
          </div>
        </Region>
      ) : row === null ? (
        <Region title="Item">
          <div className="quietline">
            It may be done, abandoned, archived or deleted. <A href={at({})}>Back to the plan</A>,{' '}
            <A href={`${at({})}?scope=archived`}>Archive</A> or{' '}
            <A href={`${at({})}?scope=deleted`}>Deleted</A>
          </div>
        </Region>
      ) : null}
      {workItem && readItemWork ? (
        <ItemWork
          key={`${projectId}:${workItem}`}
          itemId={workItem}
          read={readItemWork}
          at={at}
          project={route}
        />
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
