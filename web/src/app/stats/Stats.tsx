// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats (Items 2cf30e0a, a61d3c91): what Forge measured in this project, beside the project's own history replayed
// through a GitHub-style flow. Measured figures are facts with their source words; the replay is hatched, its lower
// bound first. The page opens with one read (the headline figures and landings per day) of the chosen period's closed
// days; each other chart is a fold that reads its own part only once opened, so an unopened fold costs nothing. A read
// re-runs only when a day in its period closes; choosing another period or opening a fold are the only other calls.
// All time reads one stored rollup per closed month and the open month's days; "Against the days before" (a range
// only) is a fold too. Today counts so far (Item 580b1a1a): opening a period that holds today asks once for a
// provisional close of today, which the server runs at most hourly and only after a landing today. Landings today are
// the live figure the top bar shows (Item 6bd1cf57); the close keeps only the derived figures, marked "as of".
import './stats.css';
import '../../ds/figures.css';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Region, useFold } from '../../ds';
import { flowToday, mainToday, utcDayStart } from '../../../../src/flow-day';
import { STATS_TODAY_REFRESH_MS, rangeDays } from '../../../../src/stats-period';
import { minutesToUsd } from '../../../../src/stats-pricing';
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
import { errorCode } from '../session';
import type { PlaceProps } from '../screens';
import { ByMonth, ByWho, PerDay, Trend, Waited } from './Charts';
import { Compare, Hint, Measured, dollarsHover } from './Compare';
import { PeriodPicker } from './PeriodPicker';
import {
  filledDays,
  gapWords,
  derivedAsOf,
  hintAsOf,
  holdsToday,
  hoursWords,
  partialWords,
  int,
  coverWords,
  periodOf,
  periodWords,
  plural,
  soFarOf,
  usd,
  valueWhen,
  withLiveToday,
  weekdayName,
  type Period,
  type StatsRead,
} from './model';

type Reply = StatsRead | { error: { message: string } };
type FoldPart = Exclude<StatsPart, 'head'>;
/** Reads one fold's part of the chosen period; called only inside an opened fold. */
export type UsePart = (part: FoldPart) => unknown;

/** A refused Stats read (a reader or a signed-out visitor) is a notice inside the frame, never a blank app. */
export default function Stats(props: PlaceProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <StatsBoundary key={attempt} retry={() => setAttempt(n => n + 1)}>
      <StatsRead {...props} />
    </StatsBoundary>
  );
}

class StatsBoundary extends Component<{ retry: () => void; children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const code = errorCode(error);
    const refused = code === 'PROJECT_UNAVAILABLE' || code === 'AUTH_REQUIRED';
    const message = (error as { data?: { message?: string } }).data?.message;
    return (
      <>
        <Head
          trail={[{ label: 'Stats' }]}
          sentence={<b>{refused ? 'Stats is for project members.' : 'Stats could not be read.'}</b>}
        />
        <div className="notice" data-st={refused ? 'waiting' : 'failed'} role={refused ? 'status' : 'alert'}>
          <span className="st" data-st={refused ? 'waiting' : 'failed'}>
            {refused ? 'No access' : 'Could not load'}
          </span>
          <p>
            {refused
              ? 'Only signed-in project members with write access can see Stats.'
              : (message ?? 'The connection dropped before Stats loaded.')}
          </p>
          {refused ? null : (
            <button type="button" className="btn sm" onClick={this.props.retry}>
              Retry
            </button>
          )}
        </div>
      </>
    );
  }
}

function StatsRead(props: PlaceProps) {
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
  const busy = result === undefined && data !== undefined;
  // Today so far: once per opening, when the period holds today, today's row is missing or an hour old, and the shell's
  // feed (no extra read) does not rule out a landing today. The server checks both again before it schedules.
  const refresh = useMutation(api.projectStatsToday.refreshToday);
  const asked = useRef(false);
  const flow = props.feedError ? undefined : props.feed?.flow;
  const stale =
    data !== undefined &&
    !busy &&
    !('error' in data) &&
    holdsToday(period, now) &&
    (soFarOf(data.todayUpTo) === null || now - data.todayUpTo! >= STATS_TODAY_REFRESH_MS);
  const today = flow ? flowToday(flow, now, utcDayStart(now)) : null;
  const landedToday = !today || today.landed > 0 || today.partial.includes('landed');
  useEffect(() => {
    if (asked.current || !stale || !landedToday) return;
    asked.current = true;
    refresh({ projectId: props.projectId }).catch(() => undefined);
  }, [stale, landedToday, refresh, props.projectId]);
  return (
    <StatsView
      data={data}
      period={period}
      busy={busy}
      now={now}
      liveLanded={flow ? mainToday(flow, now).landed : null}
      usePart={usePart}
      onPeriod={search => navigate(`${location.pathname}${search ? `?${search}` : ''}`)}
    />
  );
}

export function StatsView({
  data: read,
  period,
  busy = false,
  now,
  liveLanded = null,
  usePart,
  onPeriod,
}: {
  data: Reply | undefined;
  period: Period;
  busy?: boolean;
  now: number;
  /** Landings today from the shell's live feed (src/flow-day.ts `mainToday`), the top bar's figure; null without it. */
  liveLanded?: number | null;
  usePart: UsePart;
  /** The new address query for a chosen period ('' is this month). */
  onPeriod: (search: string) => void;
}) {
  const trail = [{ label: 'Stats' }];
  const picker = (
    <PeriodPicker key={`${period.kind}/${period.from}/${period.to}`} period={period} onPeriod={onPeriod} />
  );
  if (read === undefined)
    return (
      <Head trail={trail} sentence={<span aria-busy="true">Reading this project’s closed days…</span>}>
        {picker}
      </Head>
    );
  if ('error' in read)
    return (
      <>
        <Head trail={trail} sentence={<b>Stats could not be read.</b>}>
          {picker}
        </Head>
        <p role="alert" className="stats-note">
          {read.error.message}
        </p>
      </>
    );
  const shown = withLiveToday(read, liveLanded, period, now);
  const data = shown.data;
  const w = data.window;
  const asOf = derivedAsOf(data, period, now, shown.live, liveLanded ?? 0);
  const billing = hrefFor({ frame: 'account', place: 'billing' });
  const freshness = busy ? null : <Freshness data={data} period={period} now={now} live={shown.live} />;
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
            <Sentence data={data} period={period} asOf={asOf} />
            {freshness}
          </>
        }
      >
        {picker}
      </Head>
      {notice}
      <div className="stats" aria-busy={busy}>
        <Compare data={data} w={w} asOf={asOf} />
        <Measured w={w} asOf={asOf} />
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
            hint={hintAsOf(`the ${plural(rangeDays(period), 'day')} before`, asOf)}
          >
            {() => <Part usePart={usePart} part="trend" body={(r: StatsTrend) => <Trend r={r} />} />}
          </Fold>
        ) : null}
        <Fold
          id="waited"
          title="Where work waited"
          hint={hintAsOf('median of each stop, in minutes:seconds; the total adds the three', asOf)}
        >
          {() => (
            <Part usePart={usePart} part="waited" body={(r: StatsWaited) => <Waited stops={r.stops} />} />
          )}
        </Fold>
        <Fold
          id="agents"
          title="By agent"
          hint={asOf ? hintAsOf('agent setups and people', asOf) : undefined}
        >
          {() => <Part usePart={usePart} part="agents" body={(r: StatsAgents) => <ByWho r={r} />} />}
        </Fold>
        {(data.perMonth?.length ?? 0) > 1 ||
        (data.perDay.length > 0 && data.perDay[0]![0].slice(0, 7) !== data.perDay.at(-1)![0].slice(0, 7)) ? (
          <Fold
            id="months"
            title="By month"
            hint={hintAsOf(data.perMonth ? 'each month so far' : 'each month of this period', asOf)}
          >
            {() => <Part usePart={usePart} part="months" body={(r: StatsMonths) => <ByMonth r={r} />} />}
          </Fold>
        ) : null}
      </div>
    </>
  );
}

/** One short line: how far the figures reach. "Includes today up to 10:00 UTC." when the period holds today and today's
 * row counts so far; otherwise the newest day counted, with the time when that day still counts only so far. */
function Freshness({
  data,
  period,
  now,
  live,
}: {
  data: StatsRead;
  period: Period;
  now: number;
  live: boolean;
}) {
  const soFar = soFarOf(data.todayUpTo);
  const last = data.cover.last;
  const today = new Date(now).toISOString().slice(0, 10);
  const text =
    soFar && soFar.day === today && holdsToday(period, now)
      ? live
        ? `Landings are live; the other figures count today up to ${soFar.time} UTC.`
        : `Includes today up to ${soFar.time} UTC.`
      : last
        ? `Through ${weekdayName(last)}${soFar?.day === last ? `, ${soFar.time} UTC` : ''}.`
        : null;
  return text ? <span className="stats-freshness">{text}</span> : null;
}

function Sentence({ data, period, asOf }: { data: StatsRead; period: Period; asOf: string | null }) {
  const w = data.window,
    c = w.comparison,
    when = coverWords(period, data.cover),
    part = partialWords(w),
    mark = part ? (
      <>
        {' '}
        <Hint text={part}>Some days read in part.</Hint>
      </>
    ) : null;
  if (!c)
    return (
      <>
        <b>
          {plural(w.landings, 'landing')} {when}.
        </b>{' '}
        {w.compare.gap === 'landings'
          ? `The comparison with your own history starts at ${int(data.compareFrom)} landings; ${part ? 'what Forge measured is shown as far as it was read.' : 'what Forge measured is exact from the first.'}`
          : `${gapWords(w).text} What Forge measured is shown as it was recorded.`}
        {mark}
      </>
    );
  // The value story (Item 3678767e): what the replayed merge queue at this project's own width would have cost and
  // taken, as dollars at GitHub's list price and hours of waiting. One at a time, the worst case, stays in the chart.
  const q = c.mergeQueue;
  const dollars = usd(Math.abs(minutesToUsd(q.savedMinutes)));
  const waited = q.sooner === null ? null : q.sooner * c.landings;
  return (
    <>
      <b>
        {valueWhen(period, data.cover)}, Forge {q.savedMinutes >= 0 ? 'saved about ' : 'used about '}
        <Hint text={dollarsHover}>{dollars}</Hint> {q.savedMinutes >= 0 ? 'of CI' : 'more CI'}
        {waited === null
          ? ''
          : ` and ${waited >= 0 ? (q.savedMinutes >= 0 ? '' : 'saved ') : 'added '}${hoursWords(waited)} of waiting to reach main`}
        .
      </b>{' '}
      Against your own history replayed through a merge queue at your width, {plural(c.landings, 'landing')}
      {asOf ? `, ${asOf}` : ''}.{mark}
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
  hint?: string | undefined;
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
