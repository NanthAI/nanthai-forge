// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// "On the way to main" on Needs me (Item 85f456c1, the approved home mock): the Flow picture, the day's five figures and
// one line for checks, in one region. It replaces "Moving without you". Everything comes from the line feed the shell
// already subscribes to and the Needs you and FYI rows the page already reads: no read of its own, no timer. Below desk width the
// picture is the stops as flat rows.
import { useId, type ReactNode } from 'react';
import { FlowMotion } from './motion';
import type { DrawerStop } from './drawer-model';
import { Glyph, Region } from '../../ds';
import { A } from '../frames';
import { passedWaiting, type LineFeed } from '../Line';
import { SizedPicture, type PictureFacts } from './Picture';
import { Tag } from './labels';
import { FlowChecks, FlowLegend } from './Checks';
import type { ConflictNote } from '../lane-state';
import type { FyiRead } from '../needs/fyi';
import {
  clock,
  duration,
  flowFigures,
  flowStations,
  mainHealth,
  unverifiedMain,
  type HeldRow,
  type Station,
} from './model';
import { RecentLandings } from './RecentLandings';
import './flow.css';

/** `red`: one main red's view (code/red/<sequence>, Item ae068e0c). */
type FlowHrefs = { stats: string; lanes: string; code: string; red: (sequence: number) => string };

/** Each stop's few words at full size: what is checked there, and what is held. */
function stationFact(station: Station) {
  const parts: string[] = [];
  if (station.stop === 'saved' && station.n) parts.push('Preflight · proposed');
  const red = station.held.filter(block => block.shape === '').length;
  if (red) parts.push(`${red} held: main is failing`);
  return parts.join(' · ') || null;
}

export function FlowRegion({
  feed,
  error,
  readAt,
  mainCheckedAt,
  fyiLandings,
  deployStatus,
  stop,
  onOpen,
  laneHref,
  stationHref,
  revealHeld,
  rows,
  needsYou,
  handle,
  hrefs,
  drawnAt,
  conflicts,
}: {
  feed: LineFeed | undefined;
  error?: boolean;
  readAt?: number;
  mainCheckedAt?: number | undefined;
  fyiLandings?: FyiRead['landings'] | undefined;
  deployStatus?: ReactNode;
  stop: DrawerStop | null;
  onOpen: (stop: DrawerStop) => void;
  laneHref: (id: string) => string;
  stationHref: (stop: DrawerStop) => string;
  revealHeld: (id: string) => void;
  rows: readonly HeldRow[];
  /** Anything waits on the reader: the picture gives Needs you its width (the dock's ratio, needs.css). */
  needsYou: boolean;
  handle: ReactNode;
  hrefs: FlowHrefs;
  drawnAt: number;
  /** Each Conflict Lane's open notices, for its hover (the Lane read, only while a Lane is in conflict). */
  conflicts?: ReadonlyMap<string, readonly ConflictNote[] | undefined>;
}) {
  const passedId = useId();
  const stations = flowStations(feed, rows, conflicts);
  const day = flowFigures(feed, drawnAt);
  const tracking = !!feed && !error;
  const active = tracking && !needsYou && stations.some(s => s.n > s.held.length);
  const open = feed ? feed.lanes.length + feed.more : undefined;
  const checking = stations.find(station => station.stop === 'checking')!;
  const waiting = stations.flatMap(s => s.held).filter(block => block.colour === 'failed').length;
  const mainFact = mainHealth(day.verdict, mainCheckedAt ?? day.verdict?.checkedAt ?? undefined, drawnAt);
  const partial = new Set(day.partial);
  const facts: PictureFacts = {
    today: day.landed,
    hasMain: !!feed?.main || day.landed > 0 || !!day.verdict,
    hours: day.byHour,
    red: day.red,
    stationFacts: stations.map(stationFact),
    mainFact,
    fix: { n: day.fix, waiting },
    failed: {
      n: day.failed,
      reverted: day.reverted,
      fixedOnTop: day.fixedOnTop,
      stillRed: day.stillRed,
    },
  };
  const spark = day.byHour.slice(-12);
  const max = Math.max(1, ...spark);
  return (
    <Region
      title="On the way to main"
      weight="watch"
      count={open}
      handle={handle}
      hint={feed?.moreIsLowerBound ? 'at least this many open' : undefined}
    >
      {error ? (
        <div className="flow-error" role="status">
          <Glyph of="waiting" size={12} /> Could not refresh Flow.
          {feed && readAt !== undefined ? <> Last read at {clock(readAt, drawnAt)}.</> : null}
        </div>
      ) : null}
      <FlowMotion active={active} ariaBusy={!feed && !error}>
        <div className="flow-desk">
          <SizedPicture
            stations={stations}
            facts={facts}
            feed={tracking ? feed : undefined}
            loading={!feed}
            open={stop}
            onOpen={onOpen}
            laneHref={laneHref}
            stationHref={stationHref}
            revealHeld={revealHeld}
          />
        </div>
        <ul className="flow-rows" aria-label="Open Lanes by stop">
          {stations.map(station => (
            <li key={station.stop} className={station.n ? 'flow-row' : 'flow-row zero'}>
              <button
                type="button"
                className="flow-stop"
                aria-expanded={stop === station.stop}
                aria-describedby={station.passed ? passedId : undefined}
                onClick={() => onOpen(station.stop)}
              >
                <span className="n">{station.name}</span>{' '}
                <span className="c num">{feed ? station.count.toLocaleString('en') : '–'}</span>
              </button>
              <span className="w">
                {station.passed ? (
                  <span className="f flow-passed" id={passedId}>
                    {passedWaiting(station.passed)}
                  </span>
                ) : null}
                <span className="flow-marks" aria-hidden="true">
                  {station.blocks
                    .filter(block => !block.needsYou)
                    .map(block => (
                      <span
                        key={block.laneId}
                        className={block.running ? 'run' : undefined}
                        data-st={block.colour}
                        title={block.passed ? block.word : undefined}
                      >
                        <Glyph of={block.colour} size={10} />
                      </span>
                    ))}
                </span>
                {station.held
                  .filter(block => block.needsYou)
                  .slice(0, 3)
                  .map(block => (
                    <Tag key={block.laneId} block={block} revealHeld={revealHeld} />
                  ))}
                {stationFact(station) ? <span className="f">{stationFact(station)}</span> : null}
              </span>
            </li>
          ))}
          <li className="flow-row">
            <button
              type="button"
              className="flow-stop"
              aria-expanded={stop === 'main'}
              title={mainFact?.title}
              onClick={() => onOpen('main')}
            >
              <span className="n">main</span>
              <span className="c num">
                {feed ? day.landed.toLocaleString('en') : '–'}
                {feed ? <small>today</small> : null}
              </span>
            </button>
            <span className="w">
              {mainFact ? (
                <span className="st" data-st={mainFact.state} title={mainFact.title}>
                  <Glyph of={mainFact.state} />
                  {mainFact.word}
                </span>
              ) : feed ? (
                unverifiedMain(feed.checksConfigured)
              ) : null}
            </span>
          </li>
        </ul>
        {feed ? (
          <div className="flow-backrows">
            <span>
              Needs fix <b>{day.fix}</b> today
            </span>
            <span data-st={day.red ? 'failed' : undefined}>
              main failed <b>{day.failed}</b> today
            </span>
          </div>
        ) : null}
        {feed?.more ? (
          <div className="pf">
            {feed.more.toLocaleString('en')}
            {feed.moreIsLowerBound ? ' or more' : ''} open Lanes past the first {feed.lanes.length} are not
            drawn by stop; <A href={hrefs.lanes}>Lanes lists them all</A>.
          </div>
        ) : null}
      </FlowMotion>
      {deployStatus}
      <FlowLegend />
      {feed ? (
        <>
          <nav className="flow-figs" aria-label="Today">
            <A href={hrefs.stats} title={partial.has('landed') ? 'Partial landing count' : undefined}>
              <span className="k">Landed this hour</span>
              <b className="num">{day.thisHour.toLocaleString('en')}</b>
              <span className="flow-spark" role="img" aria-label="Landings per hour, the last 12 hours">
                {spark.map((v, i) => (
                  <i
                    key={i}
                    className={i === spark.length - 1 ? 'now' : undefined}
                    style={{ height: `${Math.max(1, (v / max) * 100).toFixed(0)}%` }}
                  />
                ))}
              </span>
              <span className="s">
                <b>{day.landed.toLocaleString('en')}</b> today
              </span>
            </A>
            <A href={hrefs.stats}>
              <span className="k">Land to main, middle</span>
              <b className="num">{day.samples ? duration(day.middle!) : '–'}</b>
              <span className="s">
                {day.samples ? (
                  <>
                    9 in 10 under <b>{duration(day.nineInTen!)}</b>
                    {partial.has('took') ? ' · partial sample' : ''}
                  </>
                ) : day.landed || partial.has('took') ? (
                  'No timing samples'
                ) : (
                  'nothing landed today'
                )}
              </span>
            </A>
            <A href={hrefs.lanes} title={partial.has('needsFix') ? 'Partial needs-fix count' : undefined}>
              <span className="k">Needs fix today</span>
              <b className="num">{day.fix.toLocaleString('en')}</b>
              <span className="s">{waiting ? `${waiting} waiting` : 'none waiting'}</span>
            </A>
            <A
              href={hrefs.code}
              title={
                partial.has('reverted') || partial.has('fixedOnTop') ? 'Partial recovery counts' : undefined
              }
            >
              <span className="k">Audit reverts today</span>
              <b className="num">{day.reverted.toLocaleString('en')}</b>
              <span className="s">
                <b>{day.fixedOnTop.toLocaleString('en')}</b> fixed on top
              </span>
            </A>
            {/* A red main links its red view (why, since when); otherwise what landed. */}
            <A href={mainFact?.red != null ? hrefs.red(mainFact.red) : hrefs.code} title={mainFact?.title}>
              {mainFact ? (
                <b>
                  <span className="st" data-st={mainFact.state}>
                    <Glyph of={mainFact.state} />
                    {mainFact.word}
                  </span>
                </b>
              ) : (
                <b>
                  <span className="nr">{unverifiedMain(feed.checksConfigured)}</span>
                </b>
              )}
            </A>
          </nav>
          <RecentLandings
            rows={feed.recentLandings}
            fyiLandings={fyiLandings}
            history={hrefs.code}
            drawnAt={drawnAt}
          />
          <FlowChecks
            checks={feed.checks}
            day={day}
            drawnAt={drawnAt}
            passed={checking.passed}
            open={stop === 'checking'}
            onOpen={() => onOpen('checking')}
          />
        </>
      ) : null}
    </Region>
  );
}
