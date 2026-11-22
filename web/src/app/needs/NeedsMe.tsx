// SPDX-License-Identifier: Apache-2.0
// Needs me (Items 9e748e41, 12fde646, 48049998, 85f456c1), the project's front page, in four sections and nothing else:
// - On the way to main (watch weight, flow/Flow.tsx): the Flow picture of every open Lane, the day's figures and one
//   line for checks, from the shell's line feed and the Needs you rows below (no read of its own). It replaced
//   "Moving without you". Left column; while Needs you holds anything the picture gives it width (1 : 1.1).
// - Needs you (the one first stop, act weight): what waits on the reader, longest held first, with one-click answers;
//   requests asked ahead are listed under it and not counted. The count is the shell's (count.ts).
// - FYI (watch weight): what the reader may want to know but need not act on, newest first, with figures for the
//   window (since the reader's last Clear all, or today), filter chips, a dismiss per row and Clear all.
// - Loose ends (reference weight), open by default (77d2e8bc): what was started and left; a reader may fold it, and a
//   folded region reads nothing.
// Reads, sent together: projectNeedsMe:read (shared with the shell's count), projectNeedsFyi:read and the planning
// counts; Loose ends while open. All re-run only on server writes; idle and hidden tabs cost nothing.
import { RecordedWho } from '../RecordedWho';
import { declaredModel, recordedIdentity, type WhoProject } from '../who-links';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  Band,
  Dock,
  Key,
  Region,
  Row,
  Segment,
  Standing,
  State,
  Who,
  useDockLayout,
  useFold,
  type DockLayout,
} from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { usePageCritical } from '../../ui/page-critical';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, Placeholder, crumbsFor } from '../Place';
import { progressCells, progressOf, type PlanCountsRead } from '../progress';
import type { PlaceProps } from '../screens';
import GettingStarted from '../start/GettingStarted';
import { FlowRegion } from '../flow/Flow';
import { jumpToRow } from '../flow/labels';
import { StationDrawer, type DrawerProps } from '../flow/Drawer';
import { isDrawerStop, type DrawerStop } from '../flow/drawer-model';
import { navigate, useSearch } from '../router';
import { AnswerKeys, HandBackDetails } from '../discussion/ConversationEntry';
import type { Answer } from '../discussion/conversation';
import { useAnswer } from '../discussion/useConversation';
import { needsRead } from './count';
import {
  fyiSum,
  fyiView,
  sinceText,
  tileText,
  type Area,
  type FyiRead,
  type FyiRow,
  type FyiState,
} from './fyi';
import { HeldSetting } from './HeldSetting';
import { LooseFold } from './LooseFold';
import {
  needsSentence,
  needsView,
  waited,
  type AheadRow,
  type AskRow,
  type NeedsRead,
  type NowRow,
  type ParkedRow,
} from './model';
import { decideTarget, useProjectDecide, type Decide } from './decide';
import { AheadKeys, DecisionKeys } from './DecisionKeys';
import './needs.css';

type ProjectRoute = PlaceProps['route'];
const fyiRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, string>(
  'projectNeedsFyi:read',
);
const fyiDismiss = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; keys?: string[]; clearAll?: boolean; restore?: FyiState },
  string
>('projectNeedsFyi:dismiss');
const dormantAbandon = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; authorityEpoch: number; abandon: string[] },
  string
>('projectHostedDormant:abandon');
/** The approved home (Item 85f456c1): the picture and FYI on the left, Needs you and Loose ends on the right. */
const LAYOUT: DockLayout = { top: [], a: ['flow', 'fyi'], b: ['needs', 'loose'] };
const PHONE_LAYOUT: DockLayout = { top: ['needs', 'flow', 'fyi', 'loose'], a: [], b: [] };
const PHONE = '(max-width: 860px)';
function watchPhone(change: () => void) {
  const query = matchMedia(PHONE);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}
/** Shown at most this many per band; the rest open in place, oldest last (DESIGN.md rule 43). */
const CAP = 4;
/** FYI rows shown before "Show more". */
const FYI_CAP = 6;

const LooseEnds = lazy(() => import('./LooseEnds'));

export default function NeedsMe(props: PlaceProps) {
  if (props.route.section === 'loose-ends')
    return (
      <Suspense
        fallback={<Head trail={crumbsFor(props.route, props.projectName)} sentence="Loading loose ends…" />}
      >
        <LooseEnds {...props} />
      </Suspense>
    );
  // The held section keeps its placeholder until it is rebuilt.
  if (props.route.section) return <Placeholder route={props.route} projectName={props.projectName} />;
  return <NeedsMeScreen {...props} />;
}

function NeedsMeScreen({ route, projectId, projectName, feed, feedError, feedReadAt }: PlaceProps) {
  const read = useQuery(needsRead, { projectId });
  const fyiLive = useQuery(fyiRead, { projectId });
  const fyi = useMemo(
    () => (fyiLive === undefined ? undefined : (JSON.parse(fyiLive) as FyiRead)),
    [fyiLive],
  );
  const counts = useQuery(api.projectPlanCounts.read, { projectId });
  usePageCritical('Needs me', {
    feed: Boolean(feed),
    needs: read !== undefined,
    fyi: fyiLive !== undefined,
    planCounts: counts !== undefined,
  });
  const decide = useProjectDecide(projectId);
  const answer = useAnswer(projectId);
  const dismissMutation = useMutation(fyiDismiss);
  const abandon = useMutation(dormantAbandon);
  return (
    <NeedsMeView
      route={route}
      projectName={projectName}
      feed={feed}
      feedError={feedError}
      feedReadAt={feedReadAt}
      drawer={props => <StationDrawer {...props} projectId={projectId} />}
      read={read}
      fyi={fyi}
      counts={counts}
      decide={decide}
      answer={answer}
      dismiss={input => dismissMutation({ projectId, ...input })}
      loose={open => (
        <LooseFold
          projectId={projectId}
          open={open}
          setAside={(epoch, ids) => abandon({ projectId, authorityEpoch: epoch, abandon: ids })}
          allHref={hrefFor({ ...route, section: 'loose-ends', rest: '' })}
        />
      )}
      settingDetail={laneId => <HeldSetting projectId={projectId} laneId={laneId} />}
      setup={
        <GettingStarted
          projectId={projectId}
          route={route}
          project={projectName}
          lanes={feed ? feed.lanes.length : 0}
        />
      }
    />
  );
}

/** Approve or decline: a Lane's request, or a landing held for review on its exact attempt (decide.ts). */
export type { Decide } from './decide';
export type { Answer } from '../discussion/conversation';
/** Dismiss FYI rows, clear them all, or put an earlier state back (projectNeedsFyi:dismiss). */
export type Dismiss = (input: { keys?: string[]; clearAll?: boolean; restore?: FyiState }) => Promise<string>;

/** The screen from its reads; `undefined` reads draw as loading. */
export function NeedsMeView({
  route,
  projectName,
  feed,
  feedError,
  feedReadAt,
  drawer,
  read,
  fyi,
  counts,
  decide,
  answer,
  dismiss,
  loose,
  setup,
  settingDetail,
  now,
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed' | 'feedError' | 'feedReadAt'> & {
  drawer?: (props: DrawerProps) => ReactNode;
  read: NeedsRead | undefined;
  fyi: FyiRead | undefined;
  counts: PlanCountsRead | undefined;
  decide: Decide;
  answer: Answer;
  dismiss: Dismiss;
  /** The Loose ends body (LooseFold), given whether its region is open so it reads only then. */
  loose?: (open: boolean) => ReactNode;
  /** Getting started (start/GettingStarted.tsx), shown while nothing waits; it hides itself once setup is done. */
  setup?: ReactNode;
  /** A held settings change, readable (Item 16093ed1); read only while its row is open. */
  settingDetail?: (laneId: string) => ReactNode;
  /** The drawing time, for tests; otherwise the time the reads arrived (nothing ticks). */
  now?: number;
}) {
  // Drawn times are relative to when the view was drawn; nothing ticks (idle costs nothing). A Lane parked with no one
  // named shows once 4 h idle by this same time (count.ts parkShown).
  // The line feed draws the picture's day, so a new landing redraws against a new time too.
  const drawnAt = useMemo(() => now ?? Date.now(), [read, fyi, feed, now]);
  const view = useMemo(() => (read ? needsView(read, drawnAt) : null), [read, drawnAt]);
  const items = progressOf(counts);
  const phone = useSyncExternalStore(
    watchPhone,
    () => matchMedia(PHONE).matches,
    () => false,
  );
  const [layout, setLayout, resetLayout, moved] = useDockLayout(
    phone ? 'needs-me-phone' : 'needs-me',
    phone ? PHONE_LAYOUT : LAYOUT,
  );
  const [message, announce] = useAnnounce();
  const list = useMemo(() => (fyi && view ? fyiView(fyi, view.fyi, drawnAt) : null), [fyi, view, drawnAt]);
  // Open by default (owner 2026-11-19): a folded Loose ends left an empty-looking box beside FYI.
  const looseFold = useFold('needs-loose', true);
  const at = (patch: Partial<ProjectRoute>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const open = useSearch().get('open');
  const stop = isDrawerStop(open) ? open : null;
  const stationHref = (next: DrawerStop | null) => {
    const url = new URL(location.href);
    if (next) url.searchParams.set('open', next);
    else url.searchParams.delete('open');
    return url.pathname + url.search + url.hash;
  };
  const closeStation = () => navigate(stationHref(null), { replace: true });
  const showStation = (next: DrawerStop) =>
    navigate(stationHref(stop === next ? null : next), { replace: true });
  const [reveal, setReveal] = useState<{ laneId: string }>();
  const revealHeld = (laneId: string) => {
    setReveal({ laneId });
    if (phone && stop) closeStation();
  };
  useEffect(() => {
    if (!reveal) return;
    const afterClose = requestAnimationFrame(() => jumpToRow(reveal.laneId));
    return () => cancelAnimationFrame(afterClose);
  }, [reveal]);
  const activityAt = (row: NowRow | AskRow | ParkedRow) => ('choices' in row ? row.at : row.since);
  const heldRows = view
    ? [...view.now, ...view.asks, ...view.parked].sort((a, b) => activityAt(a) - activityAt(b))
    : [];
  const asksAhead = view?.askedAhead ?? [];
  const conversationHref = (row: AskRow) =>
    row.laneId
      ? at({ place: 'lanes', rest: `${row.laneId}/thread` })
      : row.planningItemId
        ? at({ place: 'plan', rest: row.planningItemId }) + '#discussion'
        : undefined;
  const rowToReveal = heldRows.findIndex(
    row => !('choices' in row) && !('park' in row) && row.laneId === reveal?.laneId,
  );
  const laneHref = (laneId: string) => at({ place: 'lanes', rest: laneId });
  const drawerContent =
    stop &&
    drawer?.({
      stop,
      feed,
      rows: view?.now ?? [],
      drawnAt,
      close: closeStation,
      sheet: phone,
      laneHref,
      codeHref: at({ place: 'code' }),
      receiptHref: id => at({ place: 'code', rest: id }),
      revealHeld,
    });
  const sentence = view ? needsSentence(view) : null;
  const lanesOpen = feed ? feed.lanes.length + feed.more : null;
  const waiting = heldRows.length;

  // The picture's column is wide (1.6 : 1) until something waits on the reader, then gives Needs you the width
  // (1 : 1.1); nothing changes place (approved home mock). The rule follows whichever column holds the picture.
  const flowZone = layout.a.includes('flow') ? 'a' : layout.b.includes('flow') ? 'b' : null;
  const held = !!view?.count;
  const ratio = flowZone
    ? ({
        [`--col-${flowZone}`]: held ? '1fr' : '1.6fr',
        [`--col-${flowZone === 'a' ? 'b' : 'a'}`]: held ? '1.1fr' : '1fr',
      } as CSSProperties)
    : undefined;
  const regions = [
    {
      id: 'flow',
      title: 'On the way to main',
      render: (handle: ReactNode) => (
        <FlowRegion
          feed={feed}
          error={feedError}
          readAt={feedReadAt}
          mainCheckedAt={fyi?.mainCheckedAt}
          stop={stop}
          onOpen={showStation}
          laneHref={laneHref}
          stationHref={stationHref}
          revealHeld={revealHeld}
          rows={view?.now ?? []}
          needsYou={held}
          handle={handle}
          drawnAt={drawnAt}
          hrefs={{
            stats: at({ place: 'stats' }),
            lanes: at({ place: 'lanes' }),
            code: at({ place: 'code' }),
            red: sequence => at({ place: 'code', rest: `red/${sequence}` }),
          }}
        />
      ),
    },
    {
      id: 'needs',
      title: 'Needs you',
      render: (handle: ReactNode) => (
        <>
          <Region
            title="Needs you"
            weight={view?.count ? 'act' : 'watch'}
            waiting={
              view
                ? [
                    ...view.now.map(r => r.landing?.submissionId ?? r.laneId),
                    ...view.asks.map(r => r.id),
                    ...view.parked.map(r => r.laneId),
                  ].join()
                : 0
            }
            count={view ? view.count : undefined}
            handle={handle}
            hint="what holds work; requests asked ahead are listed under it and not counted"
          >
            {!view ? (
              <div className="quietline" aria-busy="true">
                Loading what needs you…
              </div>
            ) : (
              <>
                {waiting ? (
                  <div className="grp" data-weight="act">
                    <Band title="Holding work now" count={view.count} needs hint="longest held first" />
                    <Capped
                      rows={heldRows}
                      cap={Math.max(CAP, rowToReveal + 1)}
                      more={read!.more}
                      atLeast={view.atLeast}
                    >
                      {row => {
                        const decision =
                          'park' in row ? (
                            <Parked
                              project={route}
                              key={`park:${row.laneId}`}
                              row={row}
                              drawnAt={drawnAt}
                              laneHref={at({ place: 'lanes', rest: row.laneId })}
                            />
                          ) : 'choices' in row ? (
                            <Question
                              project={route}
                              key={row.id}
                              row={row}
                              drawnAt={drawnAt}
                              answer={answer}
                              contextHref={conversationHref(row)}
                              announce={announce}
                            />
                          ) : (
                            <Held
                              project={route}
                              key={row.landing?.submissionId ?? row.laneId}
                              row={row}
                              drawnAt={drawnAt}
                              laneHref={row.laneId ? at({ place: 'lanes', rest: row.laneId }) : null}
                              anchor={
                                view.now.find(entry => entry.laneId === row.laneId) === row
                                  ? (row.laneId ?? row.submissionId)
                                  : row.submissionId
                              }
                              decide={decide}
                              canDecide={read!.canDecide}
                              announce={announce}
                            />
                          );
                        return drawerContent && !phone ? (
                          <details
                            key={
                              'choices' in row
                                ? row.id
                                : 'park' in row
                                  ? `park:${row.laneId}`
                                  : (row.landing?.submissionId ?? row.laneId)
                            }
                            className="sumdec"
                          >
                            <summary>
                              <span className="ttl" dir="auto">
                                {'choices' in row ? row.text : row.head}
                              </span>
                            </summary>
                            {decision}
                          </details>
                        ) : (
                          decision
                        );
                      }}
                    </Capped>
                  </div>
                ) : null}
                {view.ahead.length || asksAhead.length ? (
                  <div className="grp" data-weight="watch">
                    <Band
                      title="Asked ahead"
                      count={view.ahead.length + asksAhead.length}
                      hint="not counted in Needs you until it holds work"
                    />
                    <Capped rows={view.ahead} more={0} atLeast={false}>
                      {row => (
                        <Ahead
                          project={route}
                          key={row.laneId}
                          row={row}
                          detail={row.kind === 'setting' ? settingDetail : undefined}
                          drawnAt={drawnAt}
                          decide={decide}
                          canDecide={read!.canDecide}
                          announce={announce}
                        />
                      )}
                    </Capped>
                    <Capped rows={asksAhead} more={0} atLeast={false}>
                      {row => (
                        <Question
                          project={route}
                          key={row.id}
                          row={row}
                          drawnAt={drawnAt}
                          answer={answer}
                          contextHref={conversationHref(row)}
                          announce={announce}
                        />
                      )}
                    </Capped>
                  </div>
                ) : null}
                {!waiting && !view.ahead.length && !asksAhead.length && !view.atLeast ? (
                  <div className="quietline">Nothing waits on you. Agents go on without you.</div>
                ) : null}
                {read?.asksMore ? (
                  <div className="pf">
                    Some messages could not be listed here. Open a Lane or Item to see its thread.
                  </div>
                ) : null}
                {view.approvalsComplete ? null : (
                  <div className="pf">Some requests could not be listed; the newest are shown.</div>
                )}
              </>
            )}
          </Region>
          {drawerContent}
        </>
      ),
    },
    {
      id: 'fyi',
      title: 'FYI',
      render: (handle: ReactNode) => (
        <Fyi
          handle={handle}
          view={list}
          drawnAt={drawnAt}
          dismiss={dismiss}
          announce={announce}
          href={link =>
            at({
              place: link.place as ProjectRoute['place'],
              section: link.section ?? '',
              rest: link.rest ?? '',
            })
          }
          heldHref={at({ section: 'held' })}
          state={fyi?.state}
        />
      ),
    },
    {
      id: 'loose',
      title: 'Loose ends',
      render: (handle: ReactNode) => (
        <Region
          title="Loose ends"
          weight="ref"
          handle={handle}
          fold="needs-loose"
          foldState={looseFold}
          hint="nothing here is urgent"
        >
          {loose ? loose(looseFold[0]) : null}
        </Region>
      ),
    },
  ];

  return (
    <div className="needs-me" data-held={held ? '' : undefined} style={ratio}>
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          sentence ? (
            <>
              <b>{sentence.bold}</b> {sentence.rest}
            </>
          ) : (
            'Loading what needs you…'
          )
        }
      >
        {moved ? (
          <Key kind="ghost" size="sm" onClick={resetLayout}>
            Reset layout
          </Key>
        ) : null}
      </Head>
      <LaneHelp />
      {setup && view && !view.count ? setup : null}
      <Standing
        of="app"
        {...progressCells(items, {
          inProgress:
            lanesOpen === null
              ? undefined
              : `${lanesOpen.toLocaleString()} ${lanesOpen === 1 ? 'Lane' : 'Lanes'} open${view?.now.length || view?.parked.length ? `, ${view.now.length + view.parked.length} need you` : ''}`,
          hrefs: {
            done: at({ place: 'code' }),
            inProgress: at({ place: 'lanes' }),
            left: at({ place: 'plan' }),
          },
        })}
      />
      <Dock
        label="Regions on Needs me"
        regions={regions}
        layout={layout}
        onLayout={setLayout}
        onReset={resetLayout}
        singleColumn={phone}
      />
      <Announcer message={message} />
    </div>
  );
}

/** The first rows, then the rest opening in place (oldest last). A count beyond the read says so (rule 1). */
function Capped<T>({
  rows,
  more,
  atLeast,
  cap = CAP,
  order = 'longest held first',
  children,
}: {
  rows: readonly T[];
  more: number;
  atLeast: boolean;
  cap?: number;
  order?: string;
  children: (row: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, cap);
  const hidden = rows.length - shown.length;
  return (
    <>
      {shown.map(children)}
      {hidden ? (
        <div className="pf needs-fold">
          <span>
            {shown.length} of {rows.length + more}
            {atLeast ? ' or more' : ''}, {order}
          </span>
          <Key size="sm" onClick={() => setAll(true)}>
            Show {hidden} more
          </Key>
        </div>
      ) : more ? (
        <div className="pf">
          {rows.length} of {atLeast ? 'at least ' : ''}
          {rows.length + more} shown; the rest are in Lanes.
        </div>
      ) : null}
    </>
  );
}

/** "Later": the row folds to one line for this visit. It stays open, still counted, and nobody is told. */
function Later({ head, onShow }: { head: string; onShow: () => void }) {
  return (
    <div className="pf needs-fold needs-later">
      <span className="ttl" dir="auto">
        Put off: {head}
      </span>
      <Key size="sm" onClick={onShow}>
        Show
      </Key>
    </div>
  );
}

function Held({
  row,
  project,
  drawnAt,
  laneHref,
  anchor,
  decide,
  canDecide,
  announce,
}: {
  row: NowRow;
  project: WhoProject;
  drawnAt: number;
  laneHref: string | null;
  anchor: string | null;
  decide: Decide;
  canDecide: boolean;
  announce: (text: string) => void;
}) {
  const target = decideTarget(row);
  const who = recordedIdentity(row.actor, row.agent);
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.head} onShow={() => setLater(false)} />;
  const link =
    row.why === 'conflict'
      ? 'See where they cross'
      : row.why === 'check-failed' || row.why === 'infra'
        ? 'What failed'
        : 'Open the Lane';
  return (
    <div
      className="dec"
      tabIndex={-1}
      id={anchor ? `d-${anchor}` : undefined}
      data-st={row.word === 'Conflict' ? 'conflict' : undefined}
    >
      <div className="dtop">
        <State word={row.word}>{row.tag}</State>
        <span>
          holds{' '}
          <span className="mono" translate="no">
            {row.laneId ? 'Lane' : 'Submission'} {row.mark}
          </span>
          {row.siblings > 1 ? `, 1 of ${row.siblings} held for this Item` : ''}
        </span>
        <span>waiting {waited(row.since, drawnAt)}</span>
        {who || row.agentAuthored ? (
          <RecordedWho
            handle={who}
            agentAuthored={row.agentAuthored}
            model={declaredModel(row.agentClient)}
            project={project}
          />
        ) : null}
      </div>
      <h3 dir="auto">{row.head}</h3>
      {row.note ? (
        <p className="why" dir="auto">
          {row.note}
        </p>
      ) : null}
      <div className="btns">
        {target && canDecide ? (
          <DecisionKeys laneId={row.laneId} target={target} decide={decide} announce={announce} />
        ) : null}
        {row.url ? (
          <A className="btn ghost sm" href={row.url}>
            Open approval
          </A>
        ) : null}
        {laneHref ? (
          <A className="btn ghost sm" href={laneHref}>
            {link}
          </A>
        ) : null}
        <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
          Later
        </Key>
      </div>
    </div>
  );
}

/** A Lane parked for the reader (Item e1633718): who parked it, why in their words, and how long it has waited. */
function Parked({
  row,
  drawnAt,
  laneHref,
  project,
}: {
  row: ParkedRow;
  drawnAt: number;
  laneHref: string;
  project: WhoProject;
}) {
  const who = recordedIdentity(row.who);
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.head} onShow={() => setLater(false)} />;
  return (
    <div className="dec">
      <div className="dtop">
        <State word="Needs you">{row.tag}</State>
        <span>
          <span className="mono" translate="no">
            Lane {row.mark}
          </span>
        </span>
        <span>
          {row.park.named ? 'parked' : 'idle'} {waited(row.since, drawnAt)}
        </span>
        {who ? <RecordedWho handle={who} model={null} project={project} /> : null}
      </div>
      <h3 dir="auto">{row.head}</h3>
      <p className="why" dir="auto">
        {row.park.reason}
      </p>
      <div className="btns">
        <A className="btn ghost sm" href={laneHref}>
          Open the Lane
        </A>
        <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
          Later
        </Key>
      </div>
    </div>
  );
}

/** A question with fixed choices for the reader, from a person or an agent with no terminal (12fde646). */
function Question({
  row,
  project,
  drawnAt,
  answer,
  contextHref,
  announce,
}: {
  row: AskRow;
  project: WhoProject;
  drawnAt: number;
  answer: Answer;
  contextHref: string | undefined;
  announce: (text: string) => void;
}) {
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.text} onShow={() => setLater(false)} />;
  return (
    <div className="dec">
      <div className="dtop">
        <State word="Needs you">{row.handBack ? 'Handed back' : 'Question'}</State>
        <span>
          {row.ahead ? `asked ${waited(row.at, drawnAt)} ago` : `waiting ${waited(row.at, drawnAt)}`}
        </span>
        {row.who ? (
          <RecordedWho
            handle={recordedIdentity(row.who)}
            agentAuthored={!!row.agent}
            model={null}
            project={project}
          />
        ) : null}
      </div>
      <h3 dir="auto" className="thread-choice">
        {row.handBack ? `Hand-back for Lane ${row.laneId?.slice(0, 8) ?? ''}` : row.text}
      </h3>
      {row.handBack ? <HandBackDetails {...row.handBack} tried={row.text} /> : null}
      <AnswerKeys
        entry={row}
        choices={row.choices}
        answer={answer}
        onAnswered={choice => announce(`Answered “${choice}”.`)}
      />
      <div className="btns">
        {contextHref ? (
          <A className="btn ghost sm" href={contextHref}>
            Open the thread
          </A>
        ) : null}
        <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
          Later
        </Key>
      </div>
    </div>
  );
}

function Ahead({
  row,
  project,
  detail,
  drawnAt,
  decide,
  canDecide,
  announce,
}: {
  row: AheadRow;
  project: WhoProject;
  detail?: (laneId: string) => ReactNode;
  drawnAt: number;
  decide: Decide;
  canDecide: boolean;
  announce: (text: string) => void;
}) {
  const asked = Date.parse(row.at);
  const [open, setOpen] = useState(false);
  return (
    <details className="sumdec" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <State word={row.word}>{row.tag}</State>
        <span className="ttl" dir="auto">
          {row.question}
        </span>
        <span className="meta">
          asked {Number.isNaN(asked) ? 'at a time not reported' : `${waited(asked, drawnAt)} ago`}
        </span>
      </summary>
      <div className="dec">
        <div className="dtop">
          <span>holds nothing yet</span>
          {row.who ? (
            <RecordedWho
              handle={recordedIdentity(row.who)}
              agentAuthored={!!row.agent}
              model={null}
              project={project}
            />
          ) : null}
        </div>
        <p className="why" dir="auto">
          {row.label}. {row.nextStep}
        </p>
        {open && detail ? detail(row.laneId) : null}
        {row.needsOwner && canDecide ? (
          <div className="btns">
            {row.kind === 'lane' ? (
              // A Lane request is decided on the Lane's current save, which its page shows (Item 0a99ab23).
              <A
                className="btn sm"
                href={hrefFor({
                  frame: 'project',
                  handle: project.handle,
                  project: project.project,
                  place: 'lanes',
                  section: '',
                  rest: row.laneId,
                })}
              >
                Review the Lane
              </A>
            ) : (
              <AheadKeys row={row} decide={decide} announce={announce} />
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}

const FILTERS: { value: 'all' | Area; text: string }[] = [
  { value: 'all', text: 'All' },
  { value: 'code', text: 'Code' },
  { value: 'outside', text: 'Outside the code' },
];

/** "09:58" today, "Yesterday", or the date: when a row happened, in the reader's time. */
function when(at: number, now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const date = new Date(at);
  if (at >= day.getTime()) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= day.getTime() - 86_400_000) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function Fyi({
  handle,
  view,
  state,
  drawnAt,
  dismiss,
  announce,
  href,
  heldHref,
}: {
  handle: ReactNode;
  view: ReturnType<typeof fyiView> | null;
  state: FyiState | undefined;
  drawnAt: number;
  dismiss: Dismiss;
  announce: (text: string) => void;
  href: (to: FyiRow['links'][number]['to']) => string;
  heldHref: string;
}) {
  const [filter, setFilter] = useState<'all' | Area>('all');
  const [undo, setUndo] = useState<FyiState | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (input: Parameters<Dismiss>[0], done: string) => {
    setBusy(true);
    try {
      const reply = JSON.parse(await dismiss(input)) as { before?: FyiState; error?: { message?: string } };
      if (reply.error) announce(`Not done: ${reply.error.message ?? 'Forge refused it.'}`);
      else {
        announce(done);
        return reply.before ?? null;
      }
    } catch {
      announce('Not done: Forge could not be reached. Nothing changed; try again.');
    } finally {
      setBusy(false);
    }
    return null;
  };
  const rows = view ? view.rows.filter(row => filter === 'all' || row.area === filter) : [];
  return (
    <Region
      title="FYI"
      weight="watch"
      count={view ? view.counts.all : undefined}
      handle={handle}
      sum={view ? fyiSum(view) : undefined}
      hint={view ? `nothing to act on; counted ${sinceText(view.since, drawnAt)}` : undefined}
      tools={
        view && view.rows.length ? (
          <Key
            size="sm"
            kind="ghost"
            disabled={busy || !state}
            onClick={async () => {
              const before = await send({ clearAll: true }, 'Cleared. Newer rows still show here.');
              if (before) setUndo(before);
            }}
          >
            Clear all
          </Key>
        ) : undefined
      }
    >
      {!view ? (
        <div className="quietline" aria-busy="true">
          Loading what happened…
        </div>
      ) : (
        <>
          <div className="nums" aria-label={`Counted ${sinceText(view.since, drawnAt)}`} role="group">
            {tileText(view.tiles).map(tile => (
              <div key={tile.label}>
                <b className={tile.n === 'not reported' ? 'nr' : undefined}>{tile.n}</b>
                <span>{tile.label}</span>
              </div>
            ))}
          </div>
          {undo ? (
            <div className="pf needs-fold">
              <span>Cleared.</span>
              <Key
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (await send({ restore: undo }, 'The list is back as it was.')) setUndo(null);
                }}
              >
                Undo
              </Key>
            </div>
          ) : null}
          {view.rows.length ? (
            <div className="fyi-filter">
              <Segment
                label="Show"
                value={filter}
                options={FILTERS.map(option => ({
                  value: option.value,
                  text: `${option.text} ${view.counts[option.value].toLocaleString('en')}`,
                }))}
                onChange={setFilter}
              />
            </div>
          ) : null}
          {rows.length ? (
            <Capped rows={rows} more={0} atLeast={false} cap={FYI_CAP} order="newest first">
              {row => (
                <Row key={row.key} cols="auto minmax(0, 1fr) auto auto" className="fyi-row">
                  <span className="mono t3 fyi-at">{when(row.at, drawnAt)}</span>
                  <span className="ttl" dir="auto">
                    <State word={row.word}>{row.tag}</State> {row.title}
                    <span className="meta fyi-fact">
                      {row.who ? (
                        <>
                          <Who handle={row.who} />
                          {row.fact ? ' · ' : ''}
                        </>
                      ) : null}
                      {row.fact}
                    </span>
                  </span>
                  <span className="fyi-links">
                    {row.links.map(link => (
                      <A key={link.label} className="lk" href={href(link.to)}>
                        {link.label}
                      </A>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="fyi-x"
                    aria-label={`Dismiss: ${row.title}`}
                    title="Dismiss"
                    disabled={busy}
                    onClick={() => void send({ keys: [row.key] }, 'Dismissed. It shows again if it changes.')}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </Row>
              )}
            </Capped>
          ) : (
            <div className="quietline">
              {view.rows.length ? 'Nothing of this kind.' : `Nothing new ${sinceText(view.since, drawnAt)}.`}
            </div>
          )}
          <Row cols="minmax(0, 1fr) auto">
            <A href={heldHref} className="lk">
              Everything Forge held, redid or refused
            </A>
            <span className="t3" aria-hidden="true">
              ›
            </span>
          </Row>
        </>
      )}
    </Region>
  );
}

const HELP_KEY = 'forge.firstRun.lane';
/** Rule 4 of the five-second test: the one unfamiliar word gets one line, once, until dismissed. */
function LaneHelp() {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(HELP_KEY) === null;
    } catch {
      return false;
    }
  });
  if (!shown) return null;
  return (
    <p className="needs-help">
      A Lane is one change, by a person or an agent, on its way to main.{' '}
      <button
        type="button"
        className="lk"
        onClick={() => {
          try {
            localStorage.setItem(HELP_KEY, '1');
          } catch {
            // A private window keeps it for this page only.
          }
          setShown(false);
        }}
      >
        Got it
      </button>
    </p>
  );
}
