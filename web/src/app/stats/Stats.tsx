// SPDX-License-Identifier: Apache-2.0
// Stats (Items 2cf30e0a, a61d3c91): what Forge measured in this project, beside the project's own history replayed
// through a GitHub-style flow. Measured figures are facts with their source words; the replay is hatched, its lower
// bound first. The page opens with one read (the headline figures and landings per day) of the chosen period's closed
// days; each other chart is a fold that reads its own part only once opened, so an unopened fold costs nothing. A read
// re-runs only when a day in its period closes; choosing another period or opening a fold are the only other calls.
import './stats.css';
import '../../ds/figures.css';
import { useRef, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Region, useFold } from '../../ds';
import type { StatsAgents, StatsMonths, StatsPart, StatsWaited } from '../../../../src/stats-period';
import { Head } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import type { PlaceProps } from '../screens';
import { ByMonth, ByWho, PerDay, Waited } from './Charts';
import { Compare, Measured } from './Compare';
import { PeriodPicker } from './PeriodPicker';
import {
  dayName,
  duration,
  filledDays,
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
  const period = periodOf(useSearch(), Date.now());
  const range = { projectId: props.projectId, from: period.from, to: period.to };
  const result = useQuery(api.projectStats.read, range);
  const usePart: UsePart = function usePartRead(part) {
    const reply = useQuery(api.projectStats.read, { ...range, part });
    return reply === undefined ? undefined : JSON.parse(reply);
  };
  // While another period is read, the last one stays on screen (marked busy) instead of collapsing the page.
  const last = useRef<{ data: Reply; key: string } | null>(null);
  const key = `${period.from}/${period.to}`;
  if (result !== undefined) last.current = { data: JSON.parse(result) as Reply, key };
  const data = last.current?.data;
  return (
    <StatsView
      projectName={props.projectName}
      data={data}
      period={period}
      busy={result === undefined && data !== undefined}
      historyHref={hrefFor({ ...props.route, place: 'lanes', section: 'history', rest: '' })}
      usePart={usePart}
      onPeriod={search => navigate(`${location.pathname}${search ? `?${search}` : ''}`)}
    />
  );
}

export function StatsView({
  projectName,
  data,
  period,
  busy = false,
  historyHref,
  usePart,
  onPeriod,
}: Pick<PlaceProps, 'projectName'> & {
  data: Reply | undefined;
  period: Period;
  busy?: boolean;
  historyHref: string;
  usePart: UsePart;
  /** The new address query for a chosen period ('' is this month). */
  onPeriod: (search: string) => void;
}) {
  const trail = [{ label: 'Stats' }];
  const picker = <PeriodPicker key={`${period.from}/${period.to}`} period={period} onPeriod={onPeriod} />;
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
  const notice = period.error ? (
    <p role="alert" className="stats-note">
      {period.error}
    </p>
  ) : null;
  if (!data.perDay.length)
    return (
      <>
        <Head
          trail={trail}
          sentence={
            <>
              <b>No closed days {periodWords(period)}.</b> A day closes at {projectName}’s first landing on a
              later day; its figures appear then.
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
      <Head trail={trail} sentence={<Sentence data={data} period={period} />}>
        {picker}
      </Head>
      {notice}
      <div className="stats" aria-busy={busy}>
        <Compare data={data} w={w} />
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
          <PerDay days={filledDays(data.perDay)} />
        </Region>
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
        {data.perDay[0]![0].slice(0, 7) !== data.perDay.at(-1)![0].slice(0, 7) ? (
          <Fold id="months" title="By month" hint="each month of this period">
            {() => (
              <Part
                usePart={usePart}
                part="months"
                body={(r: StatsMonths) => <ByMonth r={r} compareFrom={data.compareFrom} />}
              />
            )}
          </Fold>
        ) : null}
      </div>
    </>
  );
}

function Sentence({ data, period }: { data: StatsRead; period: Period }) {
  const w = data.window,
    c = w.comparison,
    when = coverWords(period, data.perDay);
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
