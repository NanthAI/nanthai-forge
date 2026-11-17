// SPDX-License-Identifier: Apache-2.0
// Stats (Items 2cf30e0a, a61d3c91): what Forge measured in this project, beside the project's own history replayed
// through a GitHub-style flow. Measured figures are facts with their source words; the replay is hatched, its lower
// bound first. One read of closed days; it re-runs only when a day closes.
import './stats.css';
import '../../ds/figures.css';
import { useState, type CSSProperties } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Key, Region, Table } from '../../ds';
import { Head } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import {
  clock,
  dayName,
  duration,
  int,
  minutes,
  percent,
  periods,
  plural,
  scale,
  toGo,
  type Period,
  type StatsRead,
  type StatsWindow,
} from './model';

/** The published benchmark: the only place a token comparison is made. */
const BENCHMARK = '/docs/why-forge.md';

export default function Stats(props: PlaceProps) {
  const result = useQuery(api.projectStats.read, { projectId: props.projectId });
  const data =
    result === undefined ? undefined : (JSON.parse(result) as StatsRead | { error: { message: string } });
  return <StatsView projectName={props.projectName} data={data} />;
}

export function StatsView({
  projectName,
  data,
}: Pick<PlaceProps, 'projectName'> & { data: StatsRead | { error: { message: string } } | undefined }) {
  const [pick, setPick] = useState<string | null>(null);
  const trail = [{ label: 'Stats' }];
  if (data === undefined)
    return (
      <>
        <Head trail={trail} sentence={<span aria-busy="true">Reading this project’s closed days…</span>} />
      </>
    );
  if ('error' in data)
    return (
      <>
        <Head trail={trail} sentence={<b>Stats could not be read.</b>} />
        <p role="alert" className="stats-note">
          {data.error.message}
        </p>
      </>
    );
  const list = periods(data);
  const period = list.find(p => p.key === pick) ?? list[0];
  if (!period)
    return (
      <>
        <Head
          trail={trail}
          sentence={
            <>
              <b>No closed days yet.</b> A day closes at {projectName}’s first landing on a later day; its
              measured figures appear then.
            </>
          }
        />
        <Region title="Against your own history">
          <div className="empty">
            <h3>Nothing to compare yet</h3>
            <p>
              The comparison replays your own landings. It starts once {plural(data.compareFrom, 'landing')}{' '}
              have closed.
            </p>
          </div>
        </Region>
      </>
    );
  const w = period.window;
  const billing = hrefFor({ frame: 'account', place: 'billing' });
  return (
    <>
      <Head trail={trail} sentence={<Sentence data={data} period={period} />}>
        {list.length > 1 ? (
          <label className="stats-period">
            <span className="sr">Period</span>
            <select className="inp" value={period.key} onChange={event => setPick(event.target.value)}>
              {list.map(p => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </Head>
      <div className="stats">
        <Compare data={data} w={w} label={period.label} />
        <Measured w={w} />
        <Region
          title="Landings per day"
          hint={
            <>
              {plural(w.landings, 'landing')} closed through {data.through ? dayName(data.through) : 'no day'}
              ;{' '}
              <A href={billing} className="lk">
                plan usage in Billing
              </A>
            </>
          }
        >
          <PerDay days={period.days} />
        </Region>
        <Waited w={w} />
        <ByWho w={w} />
        {data.months.length > 1 ? <ByMonth data={data} /> : null}
      </div>
    </>
  );
}

function Sentence({ data, period }: { data: StatsRead; period: Period }) {
  const w = period.window,
    c = w.comparison,
    when = period.key === 'all' ? `in the ${period.label.toLowerCase()}` : `in ${period.label}`;
  if (!c)
    return (
      <>
        <b>
          {plural(w.landings, 'landing')} {when}.
        </b>{' '}
        The comparison with your own history starts at {int(data.compareFrom)} landings; what Forge measured
        is exact from the first.
      </>
    );
  const saved = c.savedMinutes.atLeast;
  return (
    <>
      <b>
        {saved > 0
          ? `At least ${minutes(saved)} CI minutes fewer ${when}.`
          : `${plural(w.landings, 'landing')} ${when}, about as many CI minutes as your own history replayed.`}
      </b>{' '}
      {saved > 0 ? `${plural(w.landings, 'landing')}. ` : ''}
      {c.sooner !== null && c.sooner > 0
        ? `The median change reached main ${duration(c.sooner)} sooner than the same arrivals through a one-at-a-time merge queue.`
        : 'The median change reached main no sooner than the same arrivals through a one-at-a-time merge queue.'}
    </>
  );
}

function Compare({ data, w, label }: { data: StatsRead; w: StatsWindow; label: string }) {
  const [how, setHow] = useState(false);
  const c = w.comparison;
  if (!c)
    return (
      <Region title="Against your own history">
        <div className="empty">
          <h3>{plural(toGo(data, w), 'landing')} to go</h3>
          <p>Until then this page shows what was measured, with no comparison.</p>
        </div>
      </Region>
    );
  const forgeMinutes = w.measured.ciMinutes;
  const [fm, low, high] = scale([forgeMinutes, c.ciMinutes.low, c.ciMinutes.high]);
  const [ft, rt] = scale([w.measured.toMainSeconds ?? 0, c.toMainSeconds ?? 0]);
  return (
    <Region
      title="Against your own history"
      hint={`measured in this project, beside ${label} replayed through a GitHub flow`}
    >
      <div className="stats-three">
        <div className="fig">
          <h3>CI minutes, reported by your CI for landing checks</h3>
          <div className="big">
            {c.savedMinutes.atLeast > 0 ? `at least ${minutes(c.savedMinutes.atLeast)} fewer` : 'no fewer'}
            <small>
              {c.savedMinutes.upTo > c.savedMinutes.atLeast
                ? `up to ${minutes(c.savedMinutes.upTo)} fewer, `
                : ''}
              over {plural(c.pricedLandings, 'landing')} with runner minutes
            </small>
          </div>
          <div
            className="vb"
            role="img"
            aria-label={`CI minutes: Forge ${minutes(forgeMinutes)} measured. Replayed: at least ${minutes(c.ciMinutes.low)}, up to ${minutes(c.ciMinutes.high)}.`}
          >
            <div className="col">
              <span className="val">{minutes(forgeMinutes)}</span>
              <i className="forge" style={{ '--h': fm } as CSSProperties} />
            </div>
            <div className="col">
              <span className="val">
                {c.ciMinutes.high > c.ciMinutes.low
                  ? `${minutes(c.ciMinutes.low)} to ${minutes(c.ciMinutes.high)}`
                  : minutes(c.ciMinutes.low)}
              </span>
              <i className="up" style={{ '--h': high! - low! } as CSSProperties} />
              <i className="est" style={{ '--h': low } as CSSProperties} />
            </div>
          </div>
          <div className="vx" aria-hidden="true">
            <span>Forge</span>
            <span>Replayed</span>
          </div>
        </div>
        <div className="fig">
          <h3>Median time to main, from “land” to on main</h3>
          <div className="big">
            {c.sooner !== null && c.sooner > 0 ? `${duration(c.sooner)} sooner` : 'no sooner'}
            <small>per change, observed by Forge</small>
          </div>
          <div
            className="vb"
            role="img"
            aria-label={`Median time to main: Forge ${duration(w.measured.toMainSeconds)} measured. Replayed: ${duration(c.toMainSeconds)}.`}
          >
            <div className="col">
              <span className="val">
                {w.measured.toMainSeconds === null ? '–' : clock(w.measured.toMainSeconds)}
              </span>
              <i className="forge" style={{ '--h': ft } as CSSProperties} />
            </div>
            <div className="col">
              <span className="val">{c.toMainSeconds === null ? '–' : clock(c.toMainSeconds)}</span>
              <i className="est" style={{ '--h': rt } as CSSProperties} />
            </div>
          </div>
          <div className="vx" aria-hidden="true">
            <span>Forge</span>
            <span>Replayed</span>
          </div>
        </div>
        <div className="fig">
          <h3>Agent tokens</h3>
          <div className="big">
            Not reported
            <small>
              No “saved” figure: your history cannot say what another flow would have cost.{' '}
              <a className="lk" href={BENCHMARK}>
                The published benchmark
              </a>{' '}
              measured both.
            </small>
          </div>
        </div>
      </div>
      <div className="legend">
        <span>
          <i className="forge" />
          Forge, measured
        </span>
        <span>
          <i className="est" />
          Your own history replayed, lower bound
        </span>
        <span>
          <i className="up" />
          up to the upper bound
        </span>
        <Key
          kind="ghost"
          size="sm"
          className="stats-how"
          aria-expanded={how}
          aria-controls="stats-how"
          onClick={() => setHow(!how)}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6.2" />
            <path d="M8 7.2v3.8M8 5v.2" />
          </svg>
          How this is worked out
        </Key>
      </div>
      {how ? (
        <div className="stats-how-body" id="stats-how">
          <p>
            <b>Nothing here comes from a benchmark.</b> The replay uses only this project’s own landings: when
            each was sent to land, and what its full check costs (
            {c.fullCheck.runnerSeconds === null
              ? 'not recorded'
              : `${minutes(c.fullCheck.runnerSeconds / 60)} runner minutes`}
            , {duration(c.fullCheck.wallSeconds)} to finish
            {c.fullCheck.basis === 'full'
              ? ''
              : '; no full check ran, so these are the scoped checks Forge ran and the replay is low'}
            ).
          </p>
          <dl className="kv">
            <dt>Lower bound, {minutes(c.ciMinutes.low)}</dt>
            <dd>
              Each change checked once as a pull request and once in a merge queue: {plural(c.runs, 'run')}.
            </dd>
            <dt>Upper bound, {minutes(c.ciMinutes.high)}</dt>
            <dd>
              The same, plus one rerun each time another change reached main while one waited, as when
              branches must be up to date: {plural(c.reruns, 'rerun')}.
            </dd>
            <dt>Time to main, {duration(c.toMainSeconds)}</dt>
            <dd>
              The same arrival times through a queue that checks one change at a time, each taking the
              full-check time.
            </dd>
            <dt>Left out</dt>
            <dd>
              Review time, flaky reruns and conflicts found after CI, so the real figure is likely above the
              lower bound.
              {w.measured.unknownRunner
                ? ` ${plural(w.measured.unknownRunner, 'landing')} without runner minutes are left out of both CI figures, never counted as zero.`
                : ''}
            </dd>
          </dl>
        </div>
      ) : null}
    </Region>
  );
}

function Measured({ w }: { w: StatsWindow }) {
  const m = w.measured;
  return (
    <Region title="Measured" hint="facts from this project’s landings">
      <dl className="kv">
        <dt>CI minutes per landing</dt>
        <dd>
          {m.ciMinutesPerLanding === null ? 'Not reported' : `${minutes(m.ciMinutesPerLanding)} min`}{' '}
          <span className="t3">
            reported by your CI, over {plural(m.pricedLandings, 'landing')}
            {m.unknownRunner ? `; ${int(m.unknownRunner)} without runner minutes left out` : ''}
          </span>
        </dd>
        <dt>First try</dt>
        <dd>
          {percent(m.firstTryRate)}{' '}
          <span className="t3">
            landed with no resubmission and no discarded check, of {plural(m.firstTryCounted, 'landing')}
          </span>
        </dd>
        <dt>Time to main</dt>
        <dd>
          {duration(m.toMainSeconds)} <span className="t3">median, observed by Forge</span>
        </dd>
        <dt>Wasted CI minutes</dt>
        <dd>
          {minutes(m.wastedMinutes)} min{' '}
          <span className="t3">of checks that were discarded, reported by your CI</span>
        </dd>
      </dl>
    </Region>
  );
}

function PerDay({ days }: { days: Array<[string, number]> }) {
  const [table, setTable] = useState(false);
  const [at, setAt] = useState(days.length - 1);
  const heights = scale(days.map(([, n]) => n));
  const shown = days[Math.min(at, days.length - 1)];
  return (
    <>
      <div className="stats-tools">
        <Key kind="ghost" size="sm" aria-expanded={table} onClick={() => setTable(!table)}>
          {table ? 'Chart' : 'Table'}
        </Key>
      </div>
      {table ? (
        <Table
          caption="Landings per day"
          columns={[
            { key: 'day', title: 'Day', cell: ([day]: [string, number]) => dayName(day) },
            { key: 'n', title: 'Landings', numeric: true, cell: ([, n]: [string, number]) => int(n) },
          ]}
          rows={days}
          rowKey={([day]) => day}
        />
      ) : (
        <>
          <div className="stats-days" role="group" aria-label="Landings per closed day">
            {days.map(([day, n], i) => (
              <button
                key={day}
                type="button"
                aria-pressed={i === at}
                aria-label={`${dayName(day)}: ${plural(n, 'landing')}`}
                onClick={() => setAt(i)}
                onFocus={() => setAt(i)}
                onPointerEnter={() => setAt(i)}
              >
                <i style={{ '--h': heights[i] } as CSSProperties} />
              </button>
            ))}
          </div>
          <p className="stats-readout" aria-live="polite">
            {shown ? (
              <>
                <b>{dayName(shown[0])}:</b> {plural(shown[1], 'landing')}.
              </>
            ) : null}
          </p>
        </>
      )}
    </>
  );
}

function Waited({ w }: { w: StatsWindow }) {
  const { queue, check, land } = w.measured.stops;
  if (queue === null && check === null && land === null) return null;
  const parts = [
    ['In queue', queue],
    ['Checking, on your CI', check],
    ['Landing', land],
  ] as const;
  return (
    <Region title="Where work waited" hint="the median of each stop, observed by Forge">
      <div
        className="split"
        role="img"
        aria-label={parts.map(([name, s]) => `${name}: ${duration(s)}`).join('. ')}
      >
        {parts.map(([name, s]) => (
          <i
            key={name}
            className={name.startsWith('Checking') ? 'hi' : undefined}
            style={{ '--w': Math.max(1, s ?? 0) } as CSSProperties}
          />
        ))}
      </div>
      <div className="splitx" aria-hidden="true">
        {parts.map(([name, s]) => (
          <span key={name} style={{ flex: `${Math.max(1, s ?? 0)} 1 0` }}>
            <b>{s === null ? '–' : clock(s)}</b> {name}
          </span>
        ))}
      </div>
    </Region>
  );
}

type WhoRow = StatsWindow['who'][number];
function ByWho({ w }: { w: StatsWindow }) {
  if (!w.who.length) return null;
  return (
    <Region
      title="By agent"
      hint={w.others ? `${plural(w.others, 'more landing')} from others` : 'agents and people who landed'}
    >
      <Table<WhoRow>
        caption="Landings by agent"
        columns={[
          { key: 'who', title: 'Who', cell: row => row.who ?? 'not recorded' },
          { key: 'n', title: 'Landings', numeric: true, cell: row => int(row.landings) },
          { key: 'first', title: 'First try', numeric: true, cell: row => percent(row.firstTryRate) },
        ]}
        rows={w.who}
        rowKey={row => row.who ?? ''}
      />
    </Region>
  );
}

type MonthRow = StatsRead['months'][number];
function ByMonth({ data }: { data: StatsRead }) {
  return (
    <Region title="By month" hint={`${plural(data.months.length, 'month')} of closed days`}>
      <Table<MonthRow>
        caption="Stats by month"
        columns={[
          { key: 'm', title: 'Month', cell: row => periods({ ...data, months: [row] })[0]!.label },
          { key: 'n', title: 'Landings', numeric: true, cell: row => int(row.landings) },
          {
            key: 't',
            title: 'To main',
            numeric: true,
            cell: row => (row.measured.toMainSeconds === null ? '–' : clock(row.measured.toMainSeconds)),
          },
          { key: 'ci', title: 'CI min', numeric: true, cell: row => minutes(row.measured.ciMinutes) },
          {
            key: 's',
            title: 'Fewer, at least',
            numeric: true,
            cell: row =>
              row.comparison
                ? minutes(row.comparison.savedMinutes.atLeast)
                : `under ${int(data.compareFrom)} landings`,
          },
        ]}
        rows={data.months}
        rowKey={row => row.month}
      />
    </Region>
  );
}
