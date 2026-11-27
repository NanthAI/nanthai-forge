// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats charts (Item a61d3c91): landings per day, where work waited, agent setups and people and the months of a
// period. Every chart prints its values on the chart and offers the same figures as a table; all but landings per day
// are fold bodies, read only once their fold is opened.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Key, Table } from '../../ds';
import { agentAppLabels, type AgentApp } from '../start/agent-apps';
import {
  clock,
  coverDayWords,
  dayName,
  duration,
  gapWords,
  int,
  minutes,
  monthName,
  monthPartWords,
  percent,
  plural,
  scale,
  soFarOf,
} from './model';
import type { StatsAgents, StatsMonths, StatsTrend, StatsWaited } from '../../../../src/stats-period';

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
const shortMonth = (month: string) =>
  new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
/** Landings per day; a day whose close did not finish (null) is drawn as missing, never as zero. With `months` (All
 * time), one bar per month ('YYYY-MM'). */
export function PerDay({ days, months = false }: { days: Array<[string, number | null]>; months?: boolean }) {
  const [at, setAt] = useState(days.length - 1);
  const heights = scale(days.map(([, n]) => n ?? 0));
  const top = Math.max(0, ...days.map(([, n]) => n ?? 0));
  const shown = days[Math.min(at, days.length - 1)];
  const said = (n: number | null) => (n === null ? NOT_MEASURED : plural(n, 'landing'));
  const name = months ? monthName : dayName;
  const caption = months ? 'Landings per month' : 'Landings per day';
  return (
    <ChartOr
      caption={caption}
      table={
        <Table
          caption={caption}
          columns={[
            {
              key: 'day',
              title: months ? 'Month' : 'Day',
              cell: ([day]: [string, number | null]) => name(day),
            },
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
              aria-label={caption}
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
                  aria-label={`${name(day)}: ${said(n)}`}
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
                    {months ? shortMonth(day) : Number(day.slice(8))}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="stats-readout" aria-live="polite">
            {shown ? (
              <>
                <b>{name(shown[0])}:</b> {said(shown[1])}.
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

type AgentRow = StatsAgents['agentRows'][number];

function attributionLabel(row: AgentRow) {
  const { identity } = row;
  if (identity.kind === 'other') return 'Other';
  if (identity.kind === 'person')
    return identity.person ? `@${identity.person}` : 'Person · handle unavailable';
  const app = identity.app;
  const name =
    app === 'antigravity'
      ? 'Antigravity'
      : app
        ? (agentAppLabels[app as AgentApp] ?? app)
        : 'Agent app not recorded';
  return `${name} · ${identity.model ?? 'model not recorded'}`;
}

function attributionHint(row: AgentRow, minimum: number) {
  if (row.identity.kind !== 'other')
    return row.firstTryGap === null
      ? null
      : `First try ${row.firstTryGap} percentage points below the project.`;
  const { small, legacy, overflow, unattributed } = row.identity.reasons;
  return [
    small ? `${plural(small, 'landing')} from setups or people with fewer than ${minimum} each` : null,
    legacy ? `${plural(legacy, 'landing')} from older summaries without setup or person details` : null,
    overflow ? `${plural(overflow, 'landing')} whose setup or person fell outside the stored summary` : null,
    unattributed ? `${plural(unattributed, 'landing')} without a recorded setup or person` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ByWho({ r }: { r: StatsAgents }) {
  // The public identity rule can omit the handle. Use the sorted position as the key in that case.
  const rows = r.agentRows.map((row, index) => ({ ...row, key: `${attributionLabel(row)}/${index}` }));
  if (!rows.length) return <p className="stats-note">Nobody landed in this period.</p>;
  return (
    <div className="stats-by-agent">
      <Table
        caption="Landings by agent setup and person"
        columns={[
          {
            key: 'who',
            title: 'Agent setup or person',
            cell: row => {
              const hint = attributionHint(row, r.minimum);
              return (
                <>
                  {attributionLabel(row)}
                  {hint ? <small className="stats-cell-note">{hint}</small> : null}
                </>
              );
            },
          },
          { key: 'n', title: 'Landings', numeric: true, cell: row => int(row.landings) },
          {
            key: 'first',
            title: 'First try',
            numeric: true,
            cell: row => (row.firstTryRate === null ? 'Not recorded' : percent(row.firstTryRate)),
          },
          {
            key: 'time',
            title: 'Median time to main',
            numeric: true,
            cell: row =>
              row.toMainSeconds === null
                ? 'Not recorded'
                : `${row.approximate ? '≈' : ''}${duration(row.toMainSeconds)}`,
          },
          {
            key: 'ci',
            title: 'CI minutes per landing',
            numeric: true,
            cell: row =>
              row.ciMinutesPerLanding === null ? 'Not recorded' : minutes(row.ciMinutesPerLanding),
          },
        ]}
        rows={rows}
        rowKey={row => row.key}
      />
    </div>
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
          title: 'Fewer than a merge queue (estimate)',
          numeric: true,
          cell: row => (row.savedVsQueue === null ? gapWords(row).short : minutes(row.savedVsQueue)),
        },
      ]}
      rows={r.months}
      rowKey={row => row.month}
    />
  );
}

type TrendLine = StatsTrend['current'];
const TREND: Array<{
  key: string;
  title: string;
  value: (l: TrendLine) => number | null;
  show: (n: number) => string;
  change: (d: number) => string;
}> = [
  {
    key: 'n',
    title: 'Landings per closed day',
    value: l => l.landingsPerDay,
    show: n => (Math.round(n * 10) / 10).toLocaleString('en'),
    change: d => `${d > 0 ? '+' : '−'}${(Math.round(Math.abs(d) * 10) / 10).toLocaleString('en')}`,
  },
  {
    key: 'f',
    title: 'First try',
    value: l => l.firstTryRate,
    show: n => percent(n),
    change: d => `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)} pts`,
  },
  {
    key: 't',
    title: 'Median time to main',
    value: l => l.toMainSeconds,
    show: n => clock(n),
    change: d => `${duration(Math.abs(d))} ${d > 0 ? 'longer' : 'shorter'}`,
  },
  {
    key: 'c',
    title: 'CI minutes per landing',
    value: l => l.ciMinutesPerLanding,
    show: n => minutes(n),
    change: d => `${minutes(Math.abs(d))} ${d > 0 ? 'more' : 'fewer'}`,
  },
];
const spanWords = (l: TrendLine) =>
  l.cover.first === null
    ? 'no closed day'
    : l.cover.first === l.cover.last
      ? dayName(l.cover.first)
      : `${dayName(l.cover.first)} to ${dayName(l.cover.last!)}`;
/** Against the days before: this period's rates and medians beside the same number of days just before it, so a
 * project that started on Forge still has a comparison. The method is on hover. */
export function Trend({ r }: { r: StatsTrend }) {
  const now = r.current,
    then = r.previous;
  if (!then.cover.closed)
    return (
      <p className="stats-note">
        No day closed in the{' '}
        {plural(Math.round((Date.parse(then.to) - Date.parse(then.from)) / 86_400_000) + 1, 'day')} before
        this period, so there is nothing of this project’s own to set beside it yet.
      </p>
    );
  const provisional = soFarOf(r.todayUpTo)?.day === now.cover.last;
  type Row = (typeof TREND)[number];
  const cell = (l: TrendLine, row: Row) => {
    const n = row.value(l);
    return n === null ? '–' : row.show(n);
  };
  return (
    <>
      <p
        className="stats-readout"
        title={
          provisional
            ? 'Rates, medians and landings per day with figures, including the provisional summary. Days not measured are left out of both.'
            : 'Rates, medians and landings per closed day, so two periods compare however many of their days closed. Days not measured are left out of both.'
        }
      >
        <b>This period</b> {spanWords(now)} ({coverDayWords(now.cover, provisional)}), beside{' '}
        <b>the one before</b> {spanWords(then)} ({coverDayWords(then.cover, false)}).
      </p>
      <Table<Row>
        caption="This period beside the one before"
        columns={[
          {
            key: 'm',
            title: 'Figure',
            cell: row => (provisional && row.key === 'n' ? 'Landings per day with figures' : row.title),
          },
          { key: 'a', title: 'This period', numeric: true, cell: row => cell(now, row) },
          { key: 'b', title: 'The one before', numeric: true, cell: row => cell(then, row) },
          {
            key: 'd',
            title: 'Change',
            numeric: true,
            cell: row => {
              const a = row.value(now),
                b = row.value(then);
              return a === null || b === null ? '–' : a === b ? 'the same' : row.change(a - b);
            },
          },
        ]}
        rows={TREND}
        rowKey={row => row.key}
      />
    </>
  );
}
