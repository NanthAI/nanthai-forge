// SPDX-License-Identifier: Apache-2.0
// Needs me (Items 9e748e41, 12fde646), the project's front page: the page sentence answers what needs the reader,
// the standing line says what is done, in progress and left, and the first stop holds what waits on a person,
// longest held first; requests asked ahead are listed under it and not counted. Loaded with its route only.
// Reads, sent together: projectNeedsMe:read (held Lanes and open requests, one subscription) and the planning
// counts; the frame already reads the line. All re-run only on server writes; idle and hidden tabs cost nothing.
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  Band,
  Dock,
  Key,
  KindMark,
  Region,
  Row,
  Standing,
  State,
  Who,
  useDockLayout,
  type DockLayout,
} from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, Placeholder, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import GettingStarted from '../start/GettingStarted';
import {
  itemCounts,
  moving,
  needsSentence,
  needsView,
  waited,
  type AheadRow,
  type NeedsRead,
  type NowRow,
} from './model';
import { HeldSetting } from './HeldSetting';
import './needs.css';

type ProjectRoute = PlaceProps['route'];
const needsRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, NeedsRead>(
  'projectNeedsMe:read',
);
const LAYOUT: DockLayout = { top: ['needs'], a: ['moving'], b: ['more'] };
/** Shown at most this many per band; the rest open in place, oldest last (DESIGN.md rule 43). */
const CAP = 4;

export default function NeedsMe(props: PlaceProps) {
  // Its sections (held, loose ends) keep their placeholders until they are rebuilt.
  if (props.route.section) return <Placeholder route={props.route} projectName={props.projectName} />;
  return <NeedsMeScreen {...props} />;
}

function NeedsMeScreen({ route, projectId, projectName, feed }: PlaceProps) {
  const read = useQuery(needsRead, { projectId });
  const counts = useQuery(api.projectWorkIndex.records, {
    projectId,
    collection: 'planningItems',
    planningFilter: { kind: 'issue' },
    counts: true,
    paginationOpts: { numItems: 1000, cursor: null },
  });
  const mutate = useMutation(api.projectHostedApprovals.decide);
  const decide: Decide = input => mutate({ projectId, ...input, operationId: crypto.randomUUID() });
  return (
    <NeedsMeView
      route={route}
      projectName={projectName}
      feed={feed}
      read={read}
      counts={counts}
      decide={decide}
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

/** Grant or decline one open request (projectHostedApprovals:decide, retry-safe by its operation id). */
export type Decide = (input: {
  laneId: string;
  head: string;
  decision: 'grant' | 'decline';
}) => Promise<string>;

/** The screen from its reads; `undefined` reads draw as loading. */
export function NeedsMeView({
  route,
  projectName,
  feed,
  read,
  counts,
  decide,
  setup,
  settingDetail,
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed'> & {
  read: NeedsRead | undefined;
  counts: Parameters<typeof itemCounts>[0];
  decide: Decide;
  /** Getting started (start/GettingStarted.tsx), shown while nothing is held; it hides itself once setup is done. */
  setup?: ReactNode;
  /** A held settings change, readable (Item 16093ed1); read only while its row is open. */
  settingDetail?: (laneId: string) => ReactNode;
}) {
  const view = useMemo(() => (read ? needsView(read) : null), [read]);
  const items = itemCounts(counts);
  const motion = moving(feed);
  const [layout, setLayout, resetLayout] = useDockLayout('needs-me', LAYOUT);
  const [message, announce] = useAnnounce();
  // Drawn times are relative to when the view was drawn; nothing ticks (idle costs nothing).
  const drawnAt = useMemo(() => Date.now(), [read]);
  const at = (patch: Partial<ProjectRoute>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const sentence = view ? needsSentence(view) : null;
  const lanesOpen = feed ? feed.lanes.length + feed.more : null;

  const regions = [
    {
      id: 'needs',
      title: 'Needs you',
      render: (handle: ReactNode) => (
        <Region
          title="Needs you"
          weight={view?.count ? 'act' : 'watch'}
          waiting={view?.count ?? 0}
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
              {view.now.length ? (
                <div className="grp" data-weight="act">
                  <Band title="Holding work now" count={view.count} needs hint="longest held first" />
                  <Capped rows={view.now} more={read!.more} atLeast={view.atLeast}>
                    {row => (
                      <Held
                        key={row.laneId}
                        row={row}
                        drawnAt={drawnAt}
                        laneHref={at({ place: 'lanes', rest: row.laneId })}
                        decide={decide}
                        canDecide={read!.canDecide}
                        announce={announce}
                      />
                    )}
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
              {!view.now.length && !view.ahead.length ? (
                <div className="quietline">Nothing is held and no agent is waiting for an answer.</div>
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
      id: 'moving',
      title: 'Moving without you',
      render: (handle: ReactNode) => (
        <Region
          title="Moving without you"
          weight="watch"
          count={motion ? motion.total + motion.more : undefined}
          handle={handle}
          fold="needs-moving"
          sum={motion ? motion.parts || 'no Lane is moving' : undefined}
        >
          {!motion ? (
            <div className="quietline" aria-busy="true">
              Loading…
            </div>
          ) : motion.total ? (
            <Row cols="auto minmax(0, 1fr) auto">
              <KindMark kind="lane" />
              <span className="ttl">
                {motion.total.toLocaleString()} {motion.total === 1 ? 'Lane is' : 'Lanes are'} moving:{' '}
                {motion.parts}
                {motion.more ? `, and ${motion.moreIsLowerBound ? 'at least ' : ''}${motion.more} more` : ''}
              </span>
              <A className="lk" href={at({ place: 'lanes' })}>
                See them in Lanes
              </A>
            </Row>
          ) : (
            <div className="quietline">No Lane is moving.</div>
          )}
        </Region>
      ),
    },
    {
      id: 'more',
      title: 'Also here',
      render: (handle: ReactNode) => (
        <Region title="Also here" weight="ref" handle={handle} hint="nothing here is urgent">
          <Row cols="minmax(0, 1fr) auto">
            <A href={at({ section: 'held' })} className="lk">
              Everything Forge held, redid or refused
            </A>
            <span className="t3" aria-hidden="true">
              ›
            </span>
          </Row>
          <Row cols="minmax(0, 1fr) auto">
            <A href={at({ section: 'loose-ends' })} className="lk">
              Loose ends: Lanes nobody holds, stopped agents
            </A>
            <span className="t3" aria-hidden="true">
              ›
            </span>
          </Row>
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
        done={{
          n: items?.done ?? 0,
          more: items ? (feed?.main?.at ? `last landing ${clock(feed.main.at)}` : undefined) : 'not reported',
          href: at({ place: 'code' }),
        }}
        inProgress={{
          n: items?.inProgress ?? 0,
          more:
            lanesOpen === null
              ? undefined
              : `${lanesOpen.toLocaleString()} ${lanesOpen === 1 ? 'Lane' : 'Lanes'} open${view?.count ? `, ${view.count} held` : ''}`,
          href: at({ place: 'lanes' }),
        }}
        left={{
          n: items?.left ?? 0,
          more: items
            ? [
                items.proposed ? `${items.proposed.toLocaleString()} proposed` : '',
                items.complete ? '' : 'at least',
              ]
                .filter(Boolean)
                .join(', ') || undefined
            : 'not reported',
          href: at({ place: 'plan' }),
        }}
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

function clock(iso: string) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? 'not reported'
    : at.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

/** The first rows, then the rest opening in place (oldest last). A count beyond the read says so (rule 1). */
function Capped<T>({
  rows,
  more,
  atLeast,
  children,
}: {
  rows: readonly T[];
  more: number;
  atLeast: boolean;
  children: (row: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, CAP);
  const hidden = rows.length - shown.length;
  return (
    <>
      {shown.map(children)}
      {hidden ? (
        <div className="pf needs-fold">
          <span>
            {shown.length} of {rows.length + more}
            {atLeast ? ' or more' : ''}, longest held first
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

function useDecide(decide: Decide, announce: (text: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (laneId: string, head: string, decision: 'grant' | 'decline', done: string) => {
    setBusy(`${laneId}:${decision}`);
    try {
      const reply = await decide({ laneId, head, decision });
      const failed = /"error"\s*:/.test(reply)
        ? (JSON.parse(reply).error?.message as string | undefined)
        : undefined;
      announce(failed ? `Not done: ${failed}` : done);
    } catch {
      announce('Not done: Forge could not be reached. Nothing changed; try again.');
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
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
  const { run, busy } = useDecide(decide, announce);
  const approval = row.approval;
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
        <span>holds 1 Lane</span>
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
        {approval && approval.needsOwner && canDecide ? (
          <>
            <Key
              kind="rec"
              keys="a"
              disabled={busy !== null}
              onClick={() =>
                run(
                  row.laneId,
                  approval.head,
                  'grant',
                  'Approved. It lands now; main is checked again on top of it.',
                )
              }
            >
              Approve and land
            </Key>
            <Key
              disabled={busy !== null}
              onClick={() =>
                run(row.laneId, approval.head, 'decline', 'Declined. The agent was told and keeps its saves.')
              }
            >
              Decline
            </Key>
          </>
        ) : null}
        <A className="btn ghost sm" href={laneHref}>
          {link}
        </A>
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
  const { run, busy } = useDecide(decide, announce);
  const asked = Date.parse(row.at);
  const [open, setOpen] = useState(false);
  return (
    <details className="sumdec" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <State word={row.word}>{row.tag}</State>
        <span className="ttl" dir="auto">
          {row.head}
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
              onClick={() => run(row.laneId, row.head, 'grant', 'Approved. It is in the log.')}
            >
              Approve
            </Key>
            <Key
              disabled={busy !== null}
              onClick={() => run(row.laneId, row.head, 'decline', 'Declined. The agent was told.')}
            >
              Decline
            </Key>
          </div>
        ) : null}
      </div>
    </details>
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
