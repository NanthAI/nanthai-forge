// SPDX-License-Identifier: Apache-2.0
// The yard (DESIGN.md figures): every open Lane on the shell's four stops and main, in bands, stuck work first. The
// counts per stop are the shell strip's alone, never repeated here (owner dogfood 2026-11-17). Each
// row is a link to its Lane; the band that waits on the reader is the first stop. Static markup: no behaviour layer.
import type { CSSProperties } from 'react';
import { Avatar, Band, State } from '../../ds';
import { A } from '../frames';
import type { LineStage } from '../Line';
import { bandTitles, stopWords, type Band as BandName, type YardRow } from './model';

/** Where on the track a Lane sits: the middle of its stop (0 to 4, main at 4). */
const place: Record<LineStage, number> = { editing: 0.5, saved: 1.5, checking: 2.5, ready: 3.5 };
const order: readonly BandName[] = ['needs', 'queue', 'work', 'quiet'];

export function Yard({
  rows,
  hrefOf,
  dense,
}: {
  rows: readonly YardRow[];
  hrefOf: (laneId: string) => string;
  dense: boolean;
}) {
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
              hint={bandTitles[band].hint}
              needs={band === 'needs'}
            />
            {inBand.map(row => (
              <div role="listitem" key={row.laneId} style={{ display: 'contents' }}>
                <LaneLine row={row} href={hrefOf(row.laneId)} dense={dense} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function LaneLine({ row, href, dense }: { row: YardRow; href: string; dense: boolean }) {
  const who = row.actor ?? 'not reported';
  const where = `${stopWords[row.stage]}${row.position ? `, number ${row.position} in the queue` : ''}`;
  // Two open Lanes of one Item must never look the same: the short Lane mark, and how many the Item has.
  const mark = row.untitled ? null : row.mark;
  return (
    // The visible text is the link's name, in reading order (no hand-made label to drift from it); the stop and queue
    // place, drawn on the track, are spoken from a hidden line at the end.
    <A className="ln" href={href} data-st={row.state}>
      <div className="lab">
        <Avatar handle={row.actor ?? '?'} />
        <div className={dense ? 'ttl' : 'ttl wrap2'} dir="auto">
          {row.title}
        </div>
        <div className="meta cut">
          <span className="mono" translate="no" dir="auto">
            {who}
          </span>
          {mark ? (
            <>
              {' · '}
              <span className="mono" translate="no" title={`Lane ${row.laneId}`}>
                {mark}
              </span>
            </>
          ) : null}
          {row.lanes > 1 ? ` · ${row.lanes.toLocaleString()} Lanes` : null}
        </div>
      </div>
      <div className="trk" style={{ '--p': place[row.stage] } as CSSProperties} aria-hidden="true">
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
        <State word={row.glyph} state={row.state}>
          {row.word}
        </State>
        <span className="why">
          <b>{row.why}</b>
          {row.detail ? <> {row.detail}</> : null}
        </span>
        <span className="sr">. {where}</span>
      </div>
    </A>
  );
}
