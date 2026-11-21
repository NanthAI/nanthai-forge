// SPDX-License-Identifier: Apache-2.0
// The yard (DESIGN.md figures): every open Lane on the shell's four stops (Editing, Saved, In queue, Checking) and main, in bands, stuck work first. The
// Checking and passed-waiting use the shell strip's counts. Each
// row is a link to its Lane; the band that waits on the reader is the first stop. Static markup: no behaviour layer.
// A running check (Item ecd6e610) says how long it has run against the project's usual check, and its mark glides
// along the Checking stop by a CSS animation drawn from the check's start: the browser moves it with no script per
// frame and no server call. One timer at most, for the whole yard, armed only for the next minute its words change and
// never past the usual slowest check, none while live reads sleep (hidden or idle tab), when the mark rests in place.
// A Lane that saved a file another open Lane also saved says so under its row, "shares 3 files with 2 Lanes", linked to
// Who is touching what for that Lane (Item f787005c); a link of its own, beside the row's link, never inside it.
import { useEffect, useState, type CSSProperties } from 'react';
import { Avatar, Band, State } from '../../ds';
import { useReadsAsleep } from '../../live-reads';
import { A } from '../frames';
import { passedWaiting, type lineStopCounts, type LineStage } from '../Line';
import {
  CHECK_FROM,
  CHECK_TO,
  bandTitles,
  checkProgress,
  sharesWords,
  stopWords,
  type Band as BandName,
  type LaneShares,
  type YardRow,
} from './model';

/** Where on the track a Lane sits: the middle of its stop on the line's four stops (0 to 4, main at 4). A passed
 * check ('ready') counts at Checking (Line.tsx `lineStops`) and rests near its end, past a running check. */
const place: Record<LineStage, number> = {
  editing: 0.5,
  saved: 1.5,
  queued: 2.5,
  checking: 3.4,
  ready: 3.85,
};
const order: readonly BandName[] = ['needs', 'queue', 'work', 'quiet'];

export function Yard({
  rows,
  checking,
  hrefOf,
  dense,
  sharesOf,
  sharesHref,
}: {
  rows: readonly YardRow[];
  checking?: ReturnType<typeof lineStopCounts> | undefined;
  hrefOf: (laneId: string) => string;
  dense: boolean;
  /** What a Lane shares with other open Lanes, from the one overlap read; absent when it shares nothing. */
  sharesOf?: (laneId: string) => LaneShares | undefined;
  sharesHref?: (laneId: string) => string;
}) {
  const { now, asleep } = useCheckClock(rows);
  return (
    <div className={dense ? 'yard dense' : 'yard'}>
      {order.map(band => {
        const inBand = rows.filter(row => row.band === band);
        if (!inBand.length) return null;
        return (
          <div key={band} className="grp" role="list" aria-label={bandTitles[band].title}>
            <Band
              title={bandTitles[band].title}
              count={inBand.length}
              hint={
                band === 'queue' && checking?.passed
                  ? `Checking ${checking.count.toLocaleString('en')} · ${passedWaiting(checking.passed)}`
                  : bandTitles[band].hint
              }
              needs={band === 'needs'}
            />
            {inBand.map(row => {
              const shares = sharesHref ? sharesOf?.(row.laneId) : undefined;
              return (
                <div role="listitem" key={row.laneId} className={shares ? 'ln-item sh' : 'ln-item'}>
                  <LaneLine row={row} href={hrefOf(row.laneId)} dense={dense} now={now} glide={!asleep} />
                  {shares && sharesHref ? (
                    <div className="ln-sh">
                      <A className="lk" href={sharesHref(row.laneId)}>
                        <span className="sr" dir="auto">
                          {row.title}:{' '}
                        </span>
                        {sharesWords(shares)}
                      </A>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The render time for the yard's running checks, redrawn once at the next moment any of their words change by
 * themselves; asleep, nothing is armed and the marks rest. Server writes redraw it as they always do. */
function useCheckClock(rows: readonly YardRow[]) {
  const [tick, redraw] = useState(0);
  const asleep = useReadsAsleep();
  const now = Date.now();
  const next = Math.min(
    ...rows.map(row => (row.check ? checkProgress(row.check, now, clock).nextAt : Infinity)),
  );
  useEffect(() => {
    if (asleep || next === Infinity || document.hidden) return;
    const timer = setTimeout(() => redraw(n => n + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [asleep, next, tick]); // tick: a timer that fired a moment early arms again for the same moment.
  return { now, asleep };
}

function LaneLine({
  row,
  href,
  dense,
  now,
  glide,
}: {
  row: YardRow;
  href: string;
  dense: boolean;
  now: number;
  glide: boolean;
}) {
  const who = row.actor ?? 'not reported';
  const progress = row.check ? checkProgress(row.check, now, clock) : null;
  // Past the usual slowest check: the warning tone. The server's deadline still ends a dead check.
  const state = progress?.overdue ? 'waiting' : row.state;
  const why = progress ? progress.why : row.why;
  const detail = progress ? progress.detail : row.detail;
  // From where it is now to the end of the stop, over what is left of the usual check; overdue it holds at the end.
  const going = !!progress && glide && progress.fraction < 1 && row.check!.usualMs !== null;
  const track = {
    '--p': progress ? progress.at : place[row.stage],
    ...(going
      ? {
          '--p0': CHECK_FROM,
          '--p1': CHECK_TO,
          '--run': `${row.check!.usualMs}ms`,
          '--from': `${-(now - row.check!.startedAt)}ms`,
        }
      : {}),
  } as CSSProperties;
  const where = `${stopWords[row.stage]}${row.position ? `, number ${row.position} in the queue` : ''}`;
  // Two open Lanes of one Item must never look the same: the short Lane mark, and how many the Item has.
  const mark = row.untitled ? null : row.mark;
  return (
    // The visible text is the link's name, in reading order (no hand-made label to drift from it); the stop and queue
    // place, drawn on the track, are spoken from a hidden line at the end.
    <A className="ln" href={href} data-st={state}>
      <div className="lab">
        <Avatar handle={row.actor ?? '?'} />
        <div className={dense ? 'ttl' : 'ttl wrap2'} dir="auto">
          {row.title}
        </div>
        {/* The mark and the Item's Lane count come first: a dense row cuts this line at its end, and only the person
            (also on the avatar) may be cut, never what tells two Lanes apart (real case: Item 1dd4e095). */}
        <div className="meta cut">
          {mark ? (
            <>
              <span className="mono mk" translate="no" title={`Lane ${row.laneId}`}>
                {mark}
              </span>
              {' · '}
            </>
          ) : null}
          {row.lanes > 1 ? `${row.lanes.toLocaleString()} Lanes · ` : null}
          <span className="mono" translate="no" dir="auto">
            {who}
          </span>
        </div>
      </div>
      <div className={going ? 'trk going' : 'trk'} style={track} aria-hidden="true">
        <div className="rl">
          <i className="fl" />
          <div className="nw">
            <i className={row.position ? 'nd num' : 'nd'}>
              {row.position ? (row.position > 999 ? '999+' : row.position) : null}
            </i>
          </div>
        </div>
      </div>
      <div className="actn">
        <State word={row.glyph} state={state}>
          {row.word}
        </State>
        <span className="why">
          <b>{why}</b>
          {detail ? <> {detail}</> : null}
        </span>
        <span className="sr">. {where}</span>
      </div>
    </A>
  );
}
