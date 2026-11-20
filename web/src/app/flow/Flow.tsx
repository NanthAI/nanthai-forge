// SPDX-License-Identifier: Apache-2.0
// "On the way to main" on Needs me (Item 85f456c1, the approved home mock): the Flow picture, the day's five figures and
// one line for checks, in one region. It replaces "Moving without you". Everything comes from the line feed the shell
// already subscribes to and the Needs you rows the page already reads: no read of its own, no timer. Below desk width the
// picture is the stops as flat rows.
import type { ReactNode } from 'react';
import { Glyph, Region } from '../../ds';
import { A } from '../frames';
import type { LineFeed } from '../Line';
import { SizedPicture, jumpToRow, type PictureFacts } from './Picture';
import { clock, duration, flowFigures, flowStations, type HeldRow, type Station } from './model';
import './flow.css';

type FlowHrefs = { stats: string; lanes: string; code: string };

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** Each stop's few words at full size: what is checked there, and what is held. */
function stationFact(station: Station) {
  const parts: string[] = [];
  if (station.checks.length)
    parts.push(
      `${plural(station.checks.length, 'check')}, ${plural(
        station.checks.reduce((a, b) => a + b, 0),
        'Lane',
      )}`,
    );
  if (station.passed) parts.push(`${station.passed} passed, landing`);
  const red = station.held.filter(block => block.shape === '').length;
  if (red) parts.push(`${red} held: main is failing`);
  return parts.join(' · ') || null;
}

export function FlowRegion({
  feed,
  rows,
  needsYou,
  handle,
  hrefs,
  drawnAt,
}: {
  feed: LineFeed | undefined;
  rows: readonly HeldRow[];
  /** Anything waits on the reader: the picture gives Needs you its width (the dock's ratio, needs.css). */
  needsYou: boolean;
  handle: ReactNode;
  hrefs: FlowHrefs;
  drawnAt: number;
}) {
  const stations = flowStations(feed, rows);
  const day = flowFigures(feed, drawnAt);
  const open = feed ? feed.lanes.length + feed.more : undefined;
  const checking = stations.find(station => station.stop === 'checking')!;
  const waiting = stations.flatMap(s => s.held).filter(block => block.colour === 'failed').length;
  const since = day.since === null ? null : clock(day.since, drawnAt);
  const facts: PictureFacts = {
    today: day.landed,
    hours: day.byHour,
    red: day.red,
    stationFacts: stations.map(stationFact),
    mainFact: feed?.flow?.main ? { word: day.red ? 'Failing' : 'Passing', since } : null,
    fix: { n: day.fix, waiting },
    failed: { n: day.reverted + day.fixedOnTop, reverted: day.reverted, fixedOnTop: day.fixedOnTop },
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
      <div className="flow" data-calm={needsYou ? '' : undefined} aria-busy={feed ? undefined : true}>
        <div className="flow-desk">
          <SizedPicture stations={stations} facts={facts} />
        </div>
        <ul className="flow-rows" aria-label="Open Lanes by stop">
          {stations.map(station => (
            <li key={station.stop} className={station.n ? 'flow-row' : 'flow-row zero'}>
              <span className="n">{station.name}</span>
              <span className="c num">{feed ? station.n.toLocaleString('en') : '–'}</span>
              <span className="w">
                {station.held
                  .filter(block => block.needsYou)
                  .slice(0, 3)
                  .map(block => (
                    <a
                      key={block.laneId}
                      className="fv-tag"
                      data-st={block.colour}
                      href={`#d-${block.laneId}`}
                      onClick={event => {
                        if (jumpToRow(block.laneId)) event.preventDefault();
                      }}
                    >
                      <Glyph of={block.colour} size={11} />
                      {block.word}
                    </a>
                  ))}
                {stationFact(station) ? <span className="f">{stationFact(station)}</span> : null}
              </span>
            </li>
          ))}
          <li className="flow-row">
            <span className="n">main</span>
            <span className="c num">
              {day.landed.toLocaleString('en')}
              <small>today</small>
            </span>
            <span className="w">
              <span className="f">
                Needs fix {day.fix} today · main failed {day.reverted + day.fixedOnTop} today
              </span>
            </span>
          </li>
        </ul>
        {feed?.more ? (
          <div className="pf">
            {feed.more.toLocaleString('en')}
            {feed.moreIsLowerBound ? ' or more' : ''} open Lanes past the first {feed.lanes.length} are not
            drawn by stop; Lanes lists them all.
          </div>
        ) : null}
      </div>
      {feed ? (
        <>
          <nav className="flow-figs" aria-label="Today">
            <A href={hrefs.stats}>
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
                  </>
                ) : (
                  'nothing landed today'
                )}
              </span>
            </A>
            <A href={hrefs.lanes}>
              <span className="k">Needs fix today</span>
              <b className="num">{day.fix.toLocaleString('en')}</b>
              <span className="s">{waiting ? `${waiting} waiting` : 'none waiting'}</span>
            </A>
            <A href={hrefs.code}>
              <span className="k">Reverted today</span>
              <b className="num">{day.reverted.toLocaleString('en')}</b>
              <span className="s">
                <b>{day.fixedOnTop.toLocaleString('en')}</b> fixed on top
              </span>
            </A>
            <A href={hrefs.code}>
              <span className="k">main</span>
              <b>
                {feed?.flow?.main ? (
                  <span className="st" data-st={day.red ? 'failed' : 'passed'}>
                    <Glyph of={day.red ? 'failed' : 'passed'} />
                    {day.red ? 'Failing' : 'Passing'}
                  </span>
                ) : (
                  <span className="nr">not reported</span>
                )}
              </b>
              <span className="s">{since ? <>since {<b>{since}</b>}</> : 'no verdict yet today'}</span>
            </A>
          </nav>
          <div className="flow-chk">
            <b>Checks</b>
            <span>
              {checking.checks.length
                ? `${checking.checks.length} running (${checking.checks.map(n => plural(n, 'Lane')).join(', ')})`
                : 'none running'}
              {checking.passed ? `, ${checking.passed} passed` : ''}
            </span>
            <span className="ci">
              <b>{day.ciMinutes.toLocaleString('en')}</b> CI min today,{' '}
              <b>{day.lostMinutes.toLocaleString('en')}</b> on checks that did not land
            </span>
          </div>
        </>
      ) : null}
    </Region>
  );
}
