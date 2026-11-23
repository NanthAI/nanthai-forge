// SPDX-License-Identifier: Apache-2.0
// The station drawer (Item 85f456c1, the approved home mock): opened from a stop's name in the picture, a phone row or
// `?open=` (the top-bar line's stops). On a desk it stands in the column beside the picture, straight under Needs you;
// on a phone it is a sheet. Its rows sit on a log time axis from three hours ago to now. The stop's Lanes and times are
// the line feed's; titles and people come from one read made only while it is open (StationDrawer below), so an idle
// open drawer still costs nothing until the server writes.
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Glyph, Key, Region, Sheet, State } from '../../ds';
import { A } from '../frames';
import { lineStops, type LineFeed } from '../Line';
import type { LaneMeta } from '../lanes/model';
import type { Landed, LandedPage } from '../lanes/reads';
import { useSafeQuery } from '../../safe-query';
import {
  FIRST_ROWS,
  MORE_ROWS,
  TICKS,
  axisAt,
  laneDrawer,
  mainDrawer,
  type DrawerStop,
  type LaneGroup,
  type RiverRow,
} from './drawer-model';
import { duration, flowFigures, type HeldRow } from './model';

export type DrawerProps = {
  stop: DrawerStop;
  feed: LineFeed | undefined;
  rows: readonly HeldRow[];
  drawnAt: number;
  close: () => void;
  /** A phone: the drawer is a sheet. */
  sheet: boolean;
  laneHref: (laneId: string) => string;
  codeHref: string;
  receiptHref: (receiptId: string) => string;
  revealHeld: (laneId: string) => void;
};
type Reads = { lanes?: readonly LaneMeta[]; landed?: readonly Landed[]; error?: Error };

const NAMES: Record<DrawerStop, string> = {
  editing: 'Editing',
  saved: 'Saved',
  queued: 'In queue',
  checking: 'Checking',
  main: 'main',
};
const ms = (n: number) => duration(n / 1000);

function Axis() {
  return (
    <div className="fv-rax" aria-hidden="true">
      <span className="ax">
        {TICKS.map(([t, word]) => (
          <span key={word} style={{ left: `${(axisAt(t) * 100).toFixed(1)}%` }}>
            {word}
          </span>
        ))}
      </span>
    </div>
  );
}

/** One row on the river: what it is, who, and a bar from when it arrived to now. */
function River({
  title,
  who,
  ago,
  word,
  href,
  past,
  reveal,
}: {
  title: string;
  who: string | null;
  ago: number;
  word: ReactNode;
  href: string;
  past?: boolean;
  reveal?: () => void;
}) {
  const from = axisAt(ago) * 100;
  return (
    <A
      className="fv-rrow"
      href={href}
      data-weight={reveal ? 'act' : past ? 'ref' : 'watch'}
      {...(reveal
        ? {
            onClick: (event: MouseEvent) => {
              event.preventDefault();
              reveal();
            },
          }
        : {})}
    >
      <span className="w">
        <span className="ttl" dir="auto" title={title}>
          {title}
        </span>
        <span className="meta">
          {word}
          {who ? (
            <span className="mono" dir="auto" translate="no">
              {who}
            </span>
          ) : null}
        </span>
      </span>
      <span className="bar" aria-hidden="true">
        <i
          className={past ? 'past' : undefined}
          style={past ? { left: `${from.toFixed(1)}%` } : { left: `${from.toFixed(1)}%`, right: 0 }}
        />
      </span>
      <span className="d num">{past ? `${ms(ago)} ago` : ms(ago)}</span>
    </A>
  );
}

function Group({
  group,
  laneHref,
  revealHeld,
}: {
  group: LaneGroup;
  laneHref: DrawerProps['laneHref'];
  revealHeld: DrawerProps['revealHeld'];
}) {
  const [shown, setShown] = useState(FIRST_ROWS);
  const row = (r: RiverRow) => (
    <River
      key={r.id}
      title={r.title}
      who={r.who}
      ago={r.ago}
      href={r.needsYou ? `#d-${r.id}` : laneHref(r.id)}
      reveal={r.needsYou ? () => revealHeld(r.id) : undefined}
      word={
        r.block ? (
          <State
            word={
              r.block.colour === 'failed'
                ? 'Check failed'
                : r.block.colour === 'conflict'
                  ? 'Conflict'
                  : 'Waiting its turn'
            }
          >
            {r.block.word}
          </State>
        ) : null
      }
    />
  );
  return (
    <div className="grp" data-weight={group.key === 'needs' ? 'act' : 'watch'}>
      <div className="band">
        {group.check ? <Glyph of="active" size={12} /> : null}
        <span className="t">{group.title}</span>
        <span className="cnt">{group.rows.length.toLocaleString('en')}</span>
        {group.check ? (
          <span className="hint">
            {group.rows.length === 1 ? '1 Lane' : `${group.rows.length} Lanes`} checked together · shards{' '}
            <span className="prop">proposed</span>
          </span>
        ) : group.hint ? (
          <span className="hint">{group.hint}</span>
        ) : null}
      </div>
      {group.rows.slice(0, shown).map(row)}
      {group.rows.length > shown ? (
        <div className="pager">
          <span className="n">
            {shown} of {group.rows.length.toLocaleString('en')}
          </span>
          <Key size="sm" onClick={() => setShown(n => n + MORE_ROWS)}>
            Show {Math.min(MORE_ROWS, group.rows.length - shown)} more
          </Key>
        </div>
      ) : null}
    </div>
  );
}

/** The drawer's body for a stop, given the one read's answer. */
export function DrawerBody({
  stop,
  feed,
  rows,
  drawnAt,
  laneHref,
  codeHref,
  receiptHref,
  revealHeld,
  lanes,
  landed,
  error,
}: DrawerProps & Reads) {
  if (stop === 'main') {
    const day = flowFigures(feed, drawnAt);
    const view = mainDrawer(landed, day.landed, drawnAt);
    return (
      <>
        <div className="tally">
          <span>
            <b className="num">{day.landed.toLocaleString('en')}</b> today
          </span>
          <span>
            <b className="num">{day.thisHour.toLocaleString('en')}</b> this hour
          </span>
          {day.samples ? (
            <span>
              middle <b className="num">{duration(day.middle!)}</b>
            </span>
          ) : null}
        </div>
        <div className="body">
          <Axis />
          <div className="grp">
            <div className="band">
              <span className="t">Landed</span>
              <span className="cnt">{view.rows.length}</span>
              <span className="hint">newest first; the mark is when it landed</span>
              <A className="lk" href={codeHref}>
                All {view.today.toLocaleString('en')}
              </A>
            </div>
            {error ? (
              <div className="quietline">
                Could not read the newest landings; the figures above still hold.
              </div>
            ) : landed === undefined ? (
              <div className="quietline" aria-busy="true">
                Reading the newest landings…
              </div>
            ) : view.rows.length ? (
              view.rows.map(r => (
                <River
                  key={r.id}
                  title={r.title}
                  who={r.who}
                  ago={r.ago}
                  word={null}
                  href={receiptHref(r.id)}
                  past
                />
              ))
            ) : (
              <div className="quietline">Nothing has landed yet.</div>
            )}
          </div>
        </div>
      </>
    );
  }
  const view = laneDrawer(feed, rows, stop, lanes, drawnAt);
  const day = flowFigures(feed, drawnAt);
  const quiet = {
    editing: 'being edited',
    saved: 'saved and waiting',
    queued: 'in the queue',
    checking: 'being checked',
  };
  return (
    <>
      <div className="tally">
        <span>
          <b className="num">{view.here.toLocaleString('en')}</b> here
        </span>
        <span>
          <b className="num">{view.held.toLocaleString('en')}</b> held
        </span>
        {view.longest !== null ? (
          <span>
            longest <b className="num">{ms(view.longest)}</b>
          </span>
        ) : null}
      </div>
      <div className="body">
        <Axis />
        {error ? <div className="quietline">Could not read the Lanes' titles; they show by id.</div> : null}
        {view.groups.map(group => (
          <Group key={group.key} group={group} laneHref={laneHref} revealHeld={revealHeld} />
        ))}
        {!view.here ? <div className="quietline">Nothing is {quiet[stop]}.</div> : null}
        {view.more ? (
          <div className="pf">
            {view.more.toLocaleString('en')} more open Lanes are past the first {feed?.lanes.length ?? 0} and
            not placed by stop; Lanes lists them all.
          </div>
        ) : null}
        {stop === 'checking' ? (
          <div className="fv-ci">
            <span>
              <b className="num">{day.ciMinutes.toLocaleString('en')}</b> CI min today,{' '}
              <b className="num">{day.lostMinutes.toLocaleString('en')}</b> on checks that did not land ·
              checks at once <span className="prop">proposed</span>
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The drawer's frame: a region under Needs you on a desk, a sheet on a phone. Escape closes either. */
export function DrawerView(props: DrawerProps & Reads & { handle?: ReactNode }) {
  const { stop, close, sheet } = props;
  useEffect(() => {
    if (sheet) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [sheet, close]);
  if (sheet)
    return (
      <Sheet open onOpenChange={open => (open ? undefined : close())} title={NAMES[stop]}>
        <div className="fv-drawer" data-stop={stop}>
          <DrawerBody {...props} />
        </div>
      </Sheet>
    );
  return (
    <Region
      title={NAMES[stop]}
      weight="watch"
      handle={props.handle}
      hint="when each arrived here"
      tools={
        <Key size="sm" kind="ghost" keys="Esc" onClick={close}>
          Close
        </Key>
      }
    >
      <div className="fv-drawer" data-stop={stop}>
        <DrawerBody {...props} />
      </div>
    </Region>
  );
}

/** The live drawer: one read while open (the Lanes list for a Lane stop, the newest landings for main). */
export function StationDrawer(props: DrawerProps & { projectId: Id<'hostedProjects'>; handle?: ReactNode }) {
  const main = props.stop === 'main';
  const stage = lineStops.find(stop => stop.stage === props.stop);
  const named = new Set(props.rows.map(row => row.laneId));
  // Reuse the held rows already in Needs you; an empty or fully named stop needs no enrichment.
  const needsNames = props.feed?.lanes.some(
    mark => stage?.of.includes(mark.stage) && !named.has(mark.laneId),
  );
  const lanes = useSafeQuery(
    api.projectHostedLiveLanes.list,
    needsNames ? { projectId: props.projectId, cursor: null, limit: 60 } : 'skip',
  );
  const landed = useSafeQuery(
    api.projectLandingReads.list,
    main ? { projectId: props.projectId, view: 'recent' } : 'skip',
  );
  const parse = <T,>(value: string | undefined) =>
    value === undefined ? undefined : (JSON.parse(value) as T);
  return (
    <DrawerView
      {...props}
      lanes={parse<{ page: LaneMeta[] }>(lanes.value)?.page}
      landed={parse<LandedPage>(landed.value)?.rows}
      error={lanes.error ?? landed.error}
    />
  );
}
