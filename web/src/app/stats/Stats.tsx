// SPDX-License-Identifier: Apache-2.0
// Stats (Items 2cf30e0a, a61d3c91): what Forge measured in this project, beside the project's own history replayed
// through a GitHub-style flow. Measured figures are facts with their source words; the replay is hatched, its lower
// bound first. The page opens with one read (the headline figures and landings per day) of the chosen period's closed
// days; each other chart is a fold that reads its own part only once opened, so an unopened fold costs nothing. A read
// re-runs only when a day in its period closes; choosing another period or opening a fold are the only other calls.
// All time reads one stored rollup per closed month and the open month's days; "Against the days before" (a range
// only) is a fold too.
import './stats.css';
import '../../ds/figures.css';
import { useRef, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Region, useFold } from '../../ds';
import { firstTryPercent, flowToday, utcDayStart, type FlowDayFeed } from '../../../../src/flow-day';
import { rangeDays } from '../../../../src/stats-period';
import type {
  StatsAgents,
  StatsMonths,
  StatsPart,
  StatsTrend,
  StatsWaited,
} from '../../../../src/stats-period';
import { Head } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import type { PlaceProps } from '../screens';
import { ByMonth, ByWho, PerDay, Trend, Waited } from './Charts';
import { Compare, Measured } from './Compare';
import { PeriodPicker } from './PeriodPicker';
import {
  dayName,
  duration,
  filledDays,
  gapWords,
  partialWords,
  int,
  minutes,
  coverWords,
  periodOf,
  periodWords,
  plural,
  type Period,
  type StatsRead,
} from './model';

type Reply = StatsRead | { error: { message: string } };
type FoldPart = Exclude<StatsPart, 'head'>;
/** Reads one fold's part of the chosen period; called only inside an opened fold. */
export type UsePart = (part: FoldPart) => unknown;

export default function Stats(props: PlaceProps) {
  const now = Date.now();
  const period = periodOf(useSearch(), now);
  const all = period.kind === 'all';
  const range = { projectId: props.projectId, from: period.from, to: period.to };
  // One read for the chosen period: a range, or All time (the other is skipped, never read).
  const ranged = useQuery(api.projectStats.read, all ? 'skip' : range);
  const allTime = useQuery(api.projectStats.readAll, all ? { projectId: props.projectId } : 'skip');
  const result = all ? allTime : ranged;
  const usePart: UsePart = function usePartRead(part) {
    const a = useQuery(api.projectStats.read, all ? 'skip' : { ...range, part });
    const b = useQuery(api.projectStats.readAll, all ? { projectId: props.projectId, part } : 'skip');
    const reply = all ? b : a;
    return reply === undefined ? undefined : JSON.parse(reply);
  };
  // While another period is read, the last one stays on screen (marked busy) instead of collapsing the page.
  const last = useRef<{ data: Reply; key: string } | null>(null);
  const key = `${period.kind}/${period.from}/${period.to}`;
  if (result !== undefined) last.current = { data: JSON.parse(result) as Reply, key };
  const data = last.current?.data;
  return (
    <StatsView
      data={data}
      period={period}
      busy={result === undefined && data !== undefined}
      flow={props.feedError ? undefined : props.feed?.flow}
      now={now}
      historyHref={hrefFor({ ...props.route, place: 'lanes', section: 'history', rest: '' })}
      usePart={usePart}
      onPeriod={search => navigate(`${location.pathname}${search ? `?${search}` : ''}`)}
    />
  );
}

export function StatsView({
  data,
  period,
  busy = false,
  flow,
  now,
  historyHref,
  usePart,
  onPeriod,
}: {
  data: Reply | undefined;
  period: Period;
  busy?: boolean;
  flow?: FlowDayFeed | undefined;
  now: number;
  historyHref: string;
  usePart: UsePart;
  /** The new address query for a chosen period ('' is this month). */
  onPeriod: (search: string) => void;
}) {
  const trail = [{ label: 'Stats' }];
  const picker = (
    <PeriodPicker key={`${period.kind}/${period.from}/${period.to}`} period={period} onPeriod={onPeriod} />
  );
  if (data === undefined)
    return (
      <Head trail={trail} sentence={<span aria-busy="true">Reading this project’s closed days…</span>}>
        {picker}
      </Head>
    );
  if ('error' in data)
    return (
      <>
        <Head trail={trail} sentence={<b>Stats could not be read.</b>}>
          {picker}
        </Head>
        <p role="alert" className="stats-note">
          {data.error.message}
        </p>
      </>
    );
  const w = data.window;
  const billing = hrefFor({ frame: 'account', place: 'billing' });
  const freshness = busy ? null : (
    <Freshness through={data.cover.last} period={period} flow={flow} now={now} />
  );
  const notice = period.error ? (
    <p role="alert" className="stats-note">
      {period.error}
    </p>
  ) : null;
  if (!data.cover.closed && !data.cover.notMeasured)
    return (
      <>
        <Head
          trail={trail}
          sentence={
            <>
              <b>No closed days {periodWords(period)}.</b>
              {freshness}
            </>
          }
        >
          {picker}
        </Head>
        {notice}
        <Region title="Landings per day">
          <div className="empty">
            <h3>Nothing closed {periodWords(period)}</h3>
            <p>Choose another period above.</p>
          </div>
        </Region>
      </>
    );
  return (
    <>
      <Head
        trail={trail}
        sentence={
          <>
            <Sentence data={data} period={period} />
            {freshness}
          </>
        }
      >
        {picker}
      </Head>
      {notice}
      <div className="stats" aria-busy={busy}>
        <Compare data={data} w={w} />
        <Measured w={w} />
        <Region
          title={data.perMonth ? 'Landings per month' : 'Landings per day'}
          hint={
            <>
              {plural(w.landings, 'landing')} ·{' '}
              <A href={billing} className="lk">
                plan usage in Billing
              </A>
            </>
          }
        >
          {data.perMonth ? <PerDay days={data.perMonth} months /> : <PerDay days={filledDays(data.perDay)} />}
        </Region>
        {data.kind === 'range' ? (
          <Fold
            id="trend"
            title="Against the days before"
            hint={`the ${plural(rangeDays(period), 'day')} before`}
          >
            {() => <Part usePart={usePart} part="trend" body={(r: StatsTrend) => <Trend r={r} />} />}
          </Fold>
        ) : null}
        <Fold
          id="waited"
          title="Where work waited"
          hint="median of each stop, in minutes:seconds; the total adds the three"
        >
          {() => (
            <Part usePart={usePart} part="waited" body={(r: StatsWaited) => <Waited stops={r.stops} />} />
          )}
        </Fold>
        <Fold id="agents" title="By agent" hint="agents and people by first-try rate">
          {() => (
            <Part
              usePart={usePart}
              part="agents"
              body={(r: StatsAgents) => <ByWho r={r} historyHref={historyHref} />}
            />
          )}
        </Fold>
        {(data.perMonth?.length ?? 0) > 1 ||
        (data.perDay.length > 0 && data.perDay[0]![0].slice(0, 7) !== data.perDay.at(-1)![0].slice(0, 7)) ? (
          <Fold
            id="months"
            title="By month"
            hint={data.perMonth ? 'each month so far' : 'each month of this period'}
          >
            {() => <Part usePart={usePart} part="months" body={(r: StatsMonths) => <ByMonth r={r} />} />}
          </Fold>
        ) : null}
      </div>
    </>
  );
}

function Freshness({
  through,
  period,
  flow,
  now,
}: {
  through: string | null;
  period: Period;
  flow: FlowDayFeed | undefined;
  now: number;
}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const includesToday = period.kind === 'all' || (period.from <= day && day <= period.to);
  const today = flow && includesToday ? flowToday(flow, now, utcDayStart(now)) : null;
  const firstTry = today && !today.partial.includes('firstTry') ? firstTryPercent(today) : null;
  return (
    <>
      <span className="stats-freshness">
        {through ? `Through ${dayName(through)}. ` : ''}
        Stats updates after the first landing on a later UTC day.
      </span>
      {today ? (
        <span className="stats-freshness">
          Today so far (UTC) · {today.partial.includes('landed') ? 'at least ' : ''}
          {plural(today.landed, 'landing')}
          {firstTry === null ? '' : ` · ${firstTry}% first try`}
          {firstTry !== null && today.judged < today.landed ? ' among judged landings' : ''}
        </span>
      ) : null}
    </>
  );
}

function Sentence({ data, period }: { data: StatsRead; period: Period }) {
  const w = data.window,
    c = w.comparison,
    when = coverWords(period, data.cover),
    part = partialWords(w);
  if (!c)
    return (
      <>
        <b>
          {plural(w.landings, 'landing')} {when}.
        </b>{' '}
        {w.compare.gap === 'landings'
          ? `The comparison with your own history starts at ${int(data.compareFrom)} landings; ${part ? 'what Forge measured is shown as far as it was read.' : 'what Forge measured is exact from the first.'}`
          : `${gapWords(w).text} What Forge measured is shown as it was recorded.`}
        {part ? ` ${part.measured}` : ''}
      </>
    );
  // Headline against the merge queue (the setup a busy GitHub project uses); one at a time is the worst case.
  const q = c.mergeQueue,
    one = c.oneAtATime;
  const ci = (saved: number) =>
    saved >= 0 ? `${minutes(saved)} CI minutes fewer` : `${minutes(-saved)} CI minutes more`;
  const time = (s: number | null) =>
    s === null ? 'no replay' : s >= 0 ? `${duration(s)} sooner` : `${duration(-s)} later`;
  return (
    <>
      <b>
        {ci(q.savedMinutes)} than your own history replayed through a merge queue building 5 at once, {when}.
      </b>{' '}
      {plural(c.landings, 'landing')}. The median change reached main {time(q.sooner)} than through that
      queue, and {time(one.sooner)} than one at a time, the worst case.
      {part ? ` ${part.saved}` : ''}
    </>
  );
}

/** A chart behind a fold, shut by default (the reader's choice is remembered): its body, and so its read, exists only
 * while it is open. */
function Fold({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  children: () => ReactNode;
}) {
  const state = useFold(`stats-${id}`, false);
  return (
    <Region title={title} hint={hint} fold={`stats-${id}`} foldState={state}>
      {state[0] ? children() : null}
    </Region>
  );
}
function Part<R>({
  usePart,
  part,
  body,
}: {
  usePart: UsePart;
  part: FoldPart;
  body: (reply: R) => ReactNode;
}) {
  const reply = usePart(part) as R | undefined;
  return reply === undefined ? (
    <p className="stats-readout" aria-busy="true">
      Reading…
    </p>
  ) : (
    body(reply)
  );
}
