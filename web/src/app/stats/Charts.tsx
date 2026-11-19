// SPDX-License-Identifier: Apache-2.0
// Stats charts (Item a61d3c91): landings per day, where work waited, agents by first-try rate and the months of a
// period. Every chart prints its values on the chart and offers the same figures as a table; all but landings per day
// are fold bodies, read only once their fold is opened.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Key, Table } from '../../ds';
import { A } from '../frames';
import {
  clock,
  dayName,
  duration,
  gapWords,
  int,
  minutes,
  monthName,
  monthPartWords,
  plural,
  scale,
} from './model';
import type { StatsAgents, StatsMonths, StatsWaited } from '../../../../src/stats-period';

/** A chart with its table one press away (every chart offers the same figures as a table). */
function ChartOr({ caption, chart, table }: { caption: string; chart: ReactNode; table: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <>
      <div className="stats-tools">
        <Key
          kind="ghost"
          size="sm"
          aria-expanded={asTable}
          aria-label={`${asTable ? 'Chart' : 'Table'}: ${caption}`}
          onClick={() => setAsTable(!asTable)}
        >
          {asTable ? 'Chart' : 'Table'}
        </Key>
      </div>
      {asTable ? table : chart}
    </>
  );
}

/** Landings per day: fixed-width bars from the left, each with its value on top (on a narrow screen with many days,
 * the tallest, the newest and the chosen one), the day of the month under it, and the full day in the readout. */
const NOT_MEASURED = 'not measured: its close did not finish';
/** Landings per day; a day whose close did not finish (null) is drawn as missing, never as zero. */
export function PerDay({ days }: { days: Array<[string, number | null]> }) {
  const [at, setAt] = useState(days.length - 1);
  const heights = scale(days.map(([, n]) => n ?? 0));
  const top = Math.max(0, ...days.map(([, n]) => n ?? 0));
  const shown = days[Math.min(at, days.length - 1)];
  const said = (n: number | null) => (n === null ? NOT_MEASURED : plural(n, 'landing'));
  return (
    <ChartOr
      caption="Landings per day"
      table={
        <Table
          caption="Landings per day"
          columns={[
            { key: 'day', title: 'Day', cell: ([day]: [string, number | null]) => dayName(day) },
            {
              key: 'n',
              title: 'Landings',
              numeric: true,
              cell: ([, n]: [string, number | null]) => (n === null ? 'not measured' : int(n)),
            },
          ]}
          rows={days}
          rowKey={([day]) => day}
        />
      }
      chart={
        <>
          <div className="stats-plot">
            <div
              className="stats-days"
              data-dense={days.length > 14 || undefined}
              role="group"
              aria-label="Landings per closed day"
            >
              {days.map(([day, n], i) => (
                <button
                  key={day}
                  type="button"
                  className={
                    [n === top && 'key', (i === 0 || i === days.length - 1) && 'key edge']
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  aria-pressed={i === at}
                  aria-label={`${dayName(day)}: ${said(n)}`}
                  data-missing={n === null || undefined}
                  onClick={() => setAt(i)}
                  onFocus={() => setAt(i)}
                  onPointerEnter={() => setAt(i)}
                >
                  <span className="v" aria-hidden="true">
                    {n === null ? '–' : int(n)}
                  </span>
                  <i style={{ '--h': heights[i] } as CSSProperties} />
                  <span className="d" aria-hidden="true">
                    {Number(day.slice(8))}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="stats-readout" aria-live="polite">
            {shown ? (
              <>
                <b>{dayName(shown[0])}:</b> {said(shown[1])}.
              </>
            ) : null}
          </p>
        </>
      }
    />
  );
}

const STOPS = [
  ['In queue', 'queue', 'q'],
  ['Checking, on your CI', 'check', 'c'],
  ['Landing', 'land', 'l'],
] as const;
/** Where work waited: one split bar of the three median stops, each named with its value beside it, and their sum. */
export function Waited({ stops }: { stops: StatsWaited['stops'] }) {
  const parts = STOPS.map(([name, key, cls]) => ({ name, cls, s: stops[key] }));
  if (parts.every(p => p.s === null))
    return <p className="stats-note">No stop times were recorded in this period.</p>;
  const total = parts.reduce((sum, p) => sum + (p.s ?? 0), 0);
  return (
    <>
      <div
        className="split"
        role="img"
        aria-label={`${parts.map(p => `${p.name}: ${duration(p.s)}`).join('. ')}. Total: ${duration(total)}.`}
      >
        {parts.map(p => (
          <i key={p.name} className={p.cls} style={{ '--w': Math.max(1, p.s ?? 0) } as CSSProperties} />
        ))}
      </div>
      <ul className="stats-stops" aria-hidden="true">
        {parts.map(p => (
          <li key={p.name}>
            <i className={p.cls} />
            {p.name} <b>{p.s === null ? 'not recorded' : clock(p.s)}</b>
          </li>
        ))}
        <li className="sum">
          Total <b>{clock(total)}</b>
        </li>
      </ul>
    </>
  );
}

/** By agent: how many agents (and people) land at each first-try rate, in four fixed buckets, never a list that
 * grows with the agents. Each landing's own timing is on its Lane page, found from History by who landed it. */
export function ByWho({ r, historyHref }: { r: StatsAgents; historyHref: string }) {
  if (!r.agents) return <p className="stats-note">Nobody landed in this period.</p>;
  const rows = [...r.buckets, ...(r.notCounted.agents ? [{ label: 'Not counted', ...r.notCounted }] : [])];
  const heights = scale(rows.map(row => row.agents));
  type Row = (typeof rows)[number];
  return (
    <>
      <p className="stats-readout">
        {plural(r.agents, 'agent or person', 'agents and people')} by first-try rate
        {r.others ? `; ${plural(r.others, 'more landing')} from others not split` : ''}.
      </p>
      <ChartOr
        caption="Agents by first-try rate"
        table={
          <Table<Row>
            caption="Agents by first-try rate"
            columns={[
              { key: 'b', title: 'First try', cell: row => row.label },
              { key: 'a', title: 'Agents', numeric: true, cell: row => int(row.agents) },
              { key: 'n', title: 'Landings', numeric: true, cell: row => int(row.landings) },
            ]}
            rows={rows}
            rowKey={row => row.label}
          />
        }
        chart={
          <>
            <div
              className="vb stats-buckets"
              role="img"
              aria-label={rows
                .map(
                  row =>
                    `${row.label} first try: ${plural(row.agents, 'agent')}, ${plural(row.landings, 'landing')}`,
                )
                .join('. ')}
            >
              {rows.map((row, i) => (
                <div key={row.label} className="col">
                  <span className="val">{int(row.agents)}</span>
                  <i className="ink" style={{ '--h': heights[i] } as CSSProperties} />
                </div>
              ))}
            </div>
            <div className="vx stats-bx" aria-hidden="true">
              {rows.map(row => (
                <span key={row.label}>
                  {row.label}
                  <small>{plural(row.landings, 'landing')}</small>
                </span>
              ))}
            </div>
          </>
        }
      />
      <p className="stats-readout">
        Each landing’s timing is on its Lane page:{' '}
        <A href={historyHref} className="lk">
          History, by who landed it
        </A>
        .
      </p>
    </>
  );
}

type MonthRow = StatsMonths['months'][number];
export function ByMonth({ r }: { r: StatsMonths }) {
  return (
    <Table<MonthRow>
      caption="Stats by month"
      columns={[
        {
          key: 'm',
          title: 'Month',
          cell: row => (
            <>
              {monthName(row.month)}
              {row.partial ? <span className="t3"> · {monthPartWords(row)}</span> : null}
              {row.notMeasured ? (
                <span className="t3"> · {plural(row.notMeasured, 'day')} not measured</span>
              ) : null}
            </>
          ),
        },
        { key: 'n', title: 'Landings', numeric: true, cell: row => int(row.landings) },
        {
          key: 't',
          title: 'To main',
          numeric: true,
          cell: row => (row.toMainSeconds === null ? '–' : clock(row.toMainSeconds)),
        },
        {
          key: 'ci',
          title: 'CI min',
          numeric: true,
          cell: row => (row.ciMinutes === null ? 'not recorded' : minutes(row.ciMinutes)),
        },
        {
          key: 's',
          title: 'Fewer than a merge queue, replayed',
          numeric: true,
          cell: row => (row.savedVsQueue === null ? gapWords(row).short : minutes(row.savedVsQueue)),
        },
      ]}
      rows={r.months}
      rowKey={row => row.month}
    />
  );
}
