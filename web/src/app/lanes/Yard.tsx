// SPDX-License-Identifier: Apache-2.0
// The yard (DESIGN.md figures): every open Lane on the shell's four stops and main, in bands, stuck work first. Each
// row is a link to its Lane; the band that waits on the reader is the first stop. Static markup: no behaviour layer.
import type { CSSProperties } from 'react';
import { Avatar, Band, State } from '../../ds';
import { A } from '../frames';
import type { LineStage } from '../Line';
import { bandTitles, stopWords, type Band as BandName, type YardRow } from './model';

const stops: readonly LineStage[] = ['editing', 'saved', 'checking', 'ready'];
/** Where on the track a Lane sits: the middle of its stop (0 to 4, main at 4). */
const place: Record<LineStage, number> = { editing: 0.5, saved: 1.5, checking: 2.5, ready: 3.5 };
const order: readonly BandName[] = ['needs', 'queue', 'work', 'quiet'];

export function Yard({
  rows,
  hrefOf,
  dense,
  label,
}: {
  rows: readonly YardRow[];
  hrefOf: (laneId: string) => string;
  dense: boolean;
  label: string;
}) {
  const at = (stage: LineStage) => rows.filter(row => row.stage === stage).length;
  return (
    <div className={dense ? 'yard dense' : 'yard'}>
      <div className="zones" aria-hidden="true">
        <div className="zl">{label}</div>
        <div className="zs">
          {stops.map(stage => (
            <span key={stage}>
              {stopWords[stage]} <b>{at(stage).toLocaleString()}</b>
            </span>
          ))}
          <span className="zm" title="main">
            main
          </span>
        </div>
        <div className="zl" />
      </div>
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
  return (
    <A
      className="ln"
      href={href}
      data-st={row.state}
      aria-label={`${row.title}. ${row.word}: ${row.why}. ${where}. ${row.actor ?? 'person not reported'}`}
    >
      <div className="lab">
        <Avatar handle={row.actor ?? '?'} />
        <div className={dense ? 'ttl' : 'ttl wrap2'} dir="auto">
          {row.title}
        </div>
        <div className="meta cut">
          <span className="mono" translate="no" dir="auto">
            {who}
          </span>
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
        <State word="Working" state={row.state}>
          {row.word}
        </State>
        <span className="why">
          <b>{row.why}</b>
        </span>
      </div>
    </A>
  );
}
