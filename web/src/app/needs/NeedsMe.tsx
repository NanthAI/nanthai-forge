// SPDX-License-Identifier: Apache-2.0
// Needs me (Items 9e748e41, 12fde646, 48049998), the project's front page, in three sections and nothing else:
// - Needs you (the one first stop, act weight): what waits on the reader, longest held first, with one-click answers;
//   requests asked ahead are listed under it and not counted. The count is the shell's (count.ts).
// - FYI (watch weight): what the reader may want to know but need not act on, newest first, with figures for the
//   window (since the reader's last Clear all, or today), filter chips, a dismiss per row and Clear all.
// - Loose ends (reference weight), open by default (77d2e8bc): what was started and left; a reader may fold it, and a
//   folded region reads nothing.
// Reads, sent together: projectNeedsMe:read (shared with the shell's count), projectNeedsFyi:read and the planning
// counts; Loose ends while open. All re-run only on server writes; idle and hidden tabs cost nothing.
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
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
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, Placeholder, crumbsFor } from '../Place';
import { progressCells, progressOf, type PlanCountsRead } from '../progress';
import type { PlaceProps } from '../screens';
import GettingStarted from '../start/GettingStarted';
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
import { DecisionKeys, useDecideRun } from './DecisionKeys';
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
const LAYOUT: DockLayout = { top: ['needs'], a: ['fyi'], b: ['loose'] };
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

function NeedsMeScreen({ route, projectId, projectName, feed }: PlaceProps) {
  const read = useQuery(needsRead, { projectId });
  const fyiLive = useQuery(fyiRead, { projectId });
  const fyi = useMemo(
    () => (fyiLive === undefined ? undefined : (JSON.parse(fyiLive) as FyiRead)),
    [fyiLive],
  );
  const counts = useQuery(api.projectPlanCounts.read, { projectId });
  const decide = useProjectDecide(projectId);
  const publish = useMutation(api.projectCoordination.publish);
  const dismissMutation = useMutation(fyiDismiss);
  const abandon = useMutation(dormantAbandon);
  const answer: Answer = async (ask, choice) => {
    await publish({
      projectId,
      operationId: crypto.randomUUID(),
      command: { kind: 'ack', messageId: ask.id, choice, text: choice },
    });
  };
  return (
    <NeedsMeView
      route={route}
      projectName={projectName}
      feed={feed}
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
/** Answer a question with one of its choices (a coordination acknowledgement the asker reads). */
export type Answer = (ask: AskRow, choice: string) => Promise<void>;
/** Dismiss FYI rows, clear them all, or put an earlier state back (projectNeedsFyi:dismiss). */
export type Dismiss = (input: { keys?: string[]; clearAll?: boolean; restore?: FyiState }) => Promise<string>;

/** The screen from its reads; `undefined` reads draw as loading. */
export function NeedsMeView({
  route,
  projectName,
  feed,
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
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed'> & {
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
  const drawnAt = useMemo(() => now ?? Date.now(), [read, fyi, now]);
  const view = useMemo(() => (read ? needsView(read, drawnAt) : null), [read, drawnAt]);
  const items = progressOf(counts);
  const [layout, setLayout, resetLayout] = useDockLayout('needs-me', LAYOUT);
  const [message, announce] = useAnnounce();
  const list = useMemo(() => (fyi && view ? fyiView(fyi, view.fyi, drawnAt) : null), [fyi, view, drawnAt]);
  // Open by default (owner 2026-11-19): a folded Loose ends left an empty-looking box beside FYI.
  const looseFold = useFold('needs-loose', true);
  const at = (patch: Partial<ProjectRoute>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const sentence = view ? needsSentence(view) : null;
  const lanesOpen = feed ? feed.lanes.length + feed.more : null;
  const waiting = view ? view.now.length + view.asks.length + view.parked.length : 0;

  const regions = [
    {
      id: 'needs',
      title: 'Needs you',
      render: (handle: ReactNode) => (
        <Region
          title="Needs you"
          weight={view?.count ? 'act' : 'watch'}
          waiting={
            view
              ? [
                  ...view.now.map(r => r.laneId),
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
                    rows={[...view.now, ...view.asks, ...view.parked]}
                    more={read!.more}
                    atLeast={view.atLeast}
                  >
                    {row =>
                      'park' in row ? (
                        <Parked
                          key={`park:${row.laneId}`}
                          row={row}
                          drawnAt={drawnAt}
                          laneHref={at({ place: 'lanes', rest: row.laneId })}
                        />
                      ) : 'choices' in row ? (
                        <Question
                          key={row.id}
                          row={row}
                          drawnAt={drawnAt}
                          answer={answer}
                          announce={announce}
                        />
                      ) : (
                        <Held
                          key={row.laneId}
                          row={row}
                          drawnAt={drawnAt}
                          laneHref={at({ place: 'lanes', rest: row.laneId })}
                          decide={decide}
                          canDecide={read!.canDecide}
                          announce={announce}
                        />
                      )
                    }
                  </Capped>
                </div>
              ) : null}
              {view.ahead.length ? (
                <div className="grp" data-weight="watch">
                  <Band
                    title="Asked ahead"
                    count={view.ahead.length}
                    hint="not counted in Needs you until it holds work"
                  />
                  <Capped rows={view.ahead} more={0} atLeast={false}>
                    {row => (
                      <Ahead
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
                </div>
              ) : null}
              {!waiting && !view.ahead.length ? (
                <div className="quietline">Nothing waits on you. Agents go on without you.</div>
              ) : null}
              {view.approvalsComplete ? null : (
                <div className="pf">Some requests could not be listed; the newest are shown.</div>
              )}
            </>
          )}
        </Region>
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
    <div className="needs-me">
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
      />
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
  drawnAt,
  laneHref,
  decide,
  canDecide,
  announce,
}: {
  row: NowRow;
  drawnAt: number;
  laneHref: string;
  decide: Decide;
  canDecide: boolean;
  announce: (text: string) => void;
}) {
  const target = decideTarget(row);
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.head} onShow={() => setLater(false)} />;
  const link =
    row.why === 'conflict'
      ? 'See where they cross'
      : row.why === 'check-failed' || row.why === 'infra'
        ? 'What failed'
        : 'Open the Lane';
  return (
    <div className="dec" data-st={row.word === 'Conflict' ? 'conflict' : undefined}>
      <div className="dtop">
        <State word={row.word}>{row.tag}</State>
        <span>
          holds{' '}
          <span className="mono" translate="no">
            Lane {row.mark}
          </span>
          {row.siblings > 1 ? `, 1 of ${row.siblings} held for this Item` : ''}
        </span>
        <span>waiting {waited(row.since, drawnAt)}</span>
        {row.who ? <Who handle={row.who} /> : null}
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
        <A className="btn ghost sm" href={laneHref}>
          {link}
        </A>
        <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
          Later
        </Key>
      </div>
    </div>
  );
}

/** A Lane parked for the reader (Item e1633718): who parked it, why in their words, and how long it has waited. */
function Parked({ row, drawnAt, laneHref }: { row: ParkedRow; drawnAt: number; laneHref: string }) {
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
        {row.who ? <Who handle={row.who} /> : null}
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
  drawnAt,
  answer,
  announce,
}: {
  row: AskRow;
  drawnAt: number;
  answer: Answer;
  announce: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
  if (later) return <Later head={row.text} onShow={() => setLater(false)} />;
  const pick = async (choice: string) => {
    setBusy(true);
    try {
      await answer(row, choice);
      announce(`Answered “${choice}”. ${row.who ?? 'The asker'} reads it on its next check.`);
    } catch {
      announce('Not answered: Forge could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dec">
      <div className="dtop">
        <State word="Needs you">Question</State>
        <span>waiting {waited(row.at, drawnAt)}</span>
        {row.who ? <Who handle={row.who} /> : null}
      </div>
      <h3 dir="auto">{row.text}</h3>
      <div className="btns">
        {row.choices.map((choice, index) => (
          <Key
            key={choice}
            kind={index === 0 ? 'rec' : undefined}
            disabled={busy}
            onClick={() => void pick(choice)}
          >
            {choice}
          </Key>
        ))}
        <Key kind="ghost" size="sm" onClick={() => setLater(true)}>
          Later
        </Key>
      </div>
    </div>
  );
}

function Ahead({
  row,
  detail,
  drawnAt,
  decide,
  canDecide,
  announce,
}: {
  row: AheadRow;
  detail?: (laneId: string) => ReactNode;
  drawnAt: number;
  decide: Decide;
  canDecide: boolean;
  announce: (text: string) => void;
}) {
  const { run, busy } = useDecideRun(decide, announce);
  const connect = row.setting?.origin === 'github-connect';
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
          {row.who ? <Who handle={row.who} /> : null}
        </div>
        <p className="why" dir="auto">
          {row.label}. {row.nextStep}
        </p>
        {open && detail ? detail(row.laneId) : null}
        {row.needsOwner && canDecide ? (
          <div className="btns">
            <Key
              disabled={busy !== null}
              onClick={() =>
                run(
                  row.laneId,
                  { head: row.head },
                  'grant',
                  connect ? 'Allowed. Opening GitHub to authorize.' : 'Approved. It is in the log.',
                )
              }
            >
              {connect ? 'Allow on GitHub' : 'Approve'}
            </Key>
            <Key
              disabled={busy !== null}
              onClick={() => run(row.laneId, { head: row.head }, 'decline', 'Declined. The agent was told.')}
            >
              Decline
            </Key>
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
