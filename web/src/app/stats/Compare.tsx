// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats: measured beside the project's own history replayed through two GitHub setups, named by how they merge
// (Item a61d3c91; method in src/stats-estimate.ts#statsWindow), and the measured facts. Each figure leads with its
// percent against a merge queue at the project's own width, then the one-at-a-time worst case (Item 3678767e).
import { useState, type CSSProperties } from 'react';
import { Key, Region } from '../../ds';
import {
  STATS_RATE_READ_ON,
  STATS_RATE_RUNNER,
  STATS_RATE_SOURCE,
  STATS_USD_PER_RUNNER_MINUTE,
  minutesToUsd,
} from '../../../../src/stats-pricing';
import {
  clock,
  duration,
  hoursWords,
  int,
  minutes,
  gapWords,
  hintAsOf,
  percent,
  plural,
  savedPercent,
  scale,
  usd,
  type StatsRead,
  type StatsWindow,
} from './model';

/** The two replayed setups, in plain words on hover. A merge queue is named for the project's own width. */
export const ONE_AT_A_TIME = {
  name: 'One at a time',
  setting:
    'Each change waits for the one ahead to reach main, then re-runs its check on the new main: GitHub branch protection with “Require status checks to pass before merging” and “Require branches to be up to date before merging”.',
} as const;
type Comparison = NonNullable<StatsWindow['comparison']>;
/** "Merge queue, 6 at a time (your setting)"; when the setting changed inside the period, the widths it used. */
export const queueName = (q: Pick<Comparison['mergeQueue'], 'widths'>) =>
  q.widths.length > 1
    ? `Merge queue, ${q.widths[0]}–${q.widths.at(-1)} at a time (your setting)`
    : `Merge queue, ${q.widths[0]} at a time (your setting)`;
const queueSetting = (q: Pick<Comparison['mergeQueue'], 'widths'>) =>
  `GitHub ruleset: “Require merge queue”, with “Build concurrency” (maximum pull requests to build) ${q.widths.length > 1 ? `${q.widths.join(', ')} as your setting changed` : q.widths[0]} and “Maximum pull requests to merge” 1. The width is this project’s own check concurrency setting.`;

/** The reader's dollar figure and its hover: GitHub's list price, whatever the plan. */
export const dollarsHover = `Priced at GitHub’s list price for a ${STATS_RATE_RUNNER} runner, $${STATS_USD_PER_RUNNER_MINUTE} a minute (read from GitHub’s pricing page on ${STATS_RATE_READ_ON}), for every plan and public repositories too: what these minutes would cost a private repository. It assumes your checks run on that standard runner: a larger runner costs more per minute. Free or included minutes and discounts may mean your project pays less.`;

const fewerWord = (n: number) => (n >= 0 ? 'fewer' : 'more');
const soonerWord = (n: number) => (n >= 0 ? 'sooner' : 'later');
/** A saving's lead: its whole percent of the baseline, else the amount. */
const lead = (pct: number | null, amount: string) => (pct === null ? amount : `${Math.abs(pct)}%`);
const sooner = (s: number | null) =>
  s === null ? 'not replayed' : s === 0 ? 'the same' : `${duration(Math.abs(s))} ${soonerWord(s)}`;

/** One row of a horizontal bar chart: a label on one line, a bar as wide as its share of the longest, its value. */
export type BarRow = {
  name: string;
  hover?: string;
  /** A second, quieter line under the name (a count that belongs to the row). */
  sub?: string;
  value: string;
  share: number;
  kind: 'forge' | 'est' | 'ink';
  /** Set apart from the rows above it by a rule (a row outside the scale, such as "Not counted"). */
  apart?: boolean;
};
export function Bars({ rows, label }: { rows: BarRow[]; label: string }) {
  return (
    <div className="hb" role="img" aria-label={label}>
      {rows.map(row => (
        <div className="hrow" key={row.name} data-apart={row.apart || undefined}>
          <span className="hlab" title={row.hover}>
            {row.name}
            {row.sub ? <small>{row.sub}</small> : null}
          </span>
          <span className="hrail">
            {row.share > 0 ? <i className={row.kind} style={{ '--w': row.share } as CSSProperties} /> : null}
            <b className="hval">{row.value}</b>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A figure's hover on its own: keyboard focusable, so a touch or keyboard reader can reach it too. */
export function Hint({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="stats-hint" tabIndex={0} title={text} aria-label={`${text}`}>
      {children}
    </span>
  );
}

export function Compare({ w, asOf = null }: { data: StatsRead; w: StatsWindow; asOf?: string | null }) {
  const [how, setHow] = useState(false);
  const c = w.comparison;
  if (!c) {
    const gap = gapWords(w);
    return (
      <Region title="Against your own history">
        <div className="empty">
          <h3>{gap.title}</h3>
          <p>{gap.text}</p>
        </div>
      </Region>
    );
  }
  const one = c.oneAtATime,
    queue = c.mergeQueue;
  const name = queueName(queue);
  const [fm, om, qm] = scale([c.forgeMinutes, one.ciMinutes, queue.ciMinutes]);
  // Forge's median over the same days the replays cover, so the bars and the headline agree.
  const forgeToMain = c.forgeToMainSeconds;
  const [ft, ot, qt] = scale([forgeToMain ?? 0, one.toMainSeconds ?? 0, queue.toMainSeconds ?? 0]);
  const ciQueue = savedPercent(queue.savedMinutes, queue.ciMinutes),
    ciOne = savedPercent(one.savedMinutes, one.ciMinutes),
    timeQueue = savedPercent(queue.sooner, queue.toMainSeconds),
    timeOne = savedPercent(one.sooner, one.toMainSeconds);
  const waited = queue.sooner === null ? null : queue.sooner * c.landings;
  return (
    <Region
      title="Against your own history"
      hint={hintAsOf(
        'measured in this project, beside the same days replayed through two GitHub setups',
        asOf,
      )}
    >
      <div className="stats-figs">
        <div className="fig">
          <h3>CI minutes, every check run</h3>
          <div className="big">
            {lead(ciQueue, minutes(Math.abs(queue.savedMinutes)))} {fewerWord(queue.savedMinutes)} CI minutes
            <small>
              than a merge queue at your width · {lead(ciOne, minutes(Math.abs(one.savedMinutes)))}{' '}
              {fewerWord(one.savedMinutes)} than one at a time, the worst case
            </small>
            <small>
              {minutes(Math.abs(queue.savedMinutes))} minutes {fewerWord(queue.savedMinutes)}, about{' '}
              <Hint text={dollarsHover}>{usd(Math.abs(minutesToUsd(queue.savedMinutes)))}</Hint> at GitHub
              list price, over {plural(c.landings, 'landing')}
            </small>
          </div>
          <Bars
            label={`CI minutes: Forge ${minutes(c.forgeMinutes)} measured. Replayed estimates: ${name} ${minutes(queue.ciMinutes)}, one at a time ${minutes(one.ciMinutes)}.`}
            rows={[
              { name: 'Forge', value: minutes(c.forgeMinutes), share: fm!, kind: 'forge' },
              { name, hover: queueSetting(queue), value: minutes(queue.ciMinutes), share: qm!, kind: 'est' },
              {
                name: ONE_AT_A_TIME.name,
                hover: ONE_AT_A_TIME.setting,
                value: minutes(one.ciMinutes),
                share: om!,
                kind: 'est',
              },
            ]}
          />
        </div>
        <div className="fig">
          <h3>Median time to main, from “land” to on main</h3>
          <div className="big">
            {timeQueue === null
              ? sooner(queue.sooner)
              : `${Math.abs(timeQueue)}% ${soonerWord(queue.sooner!)} to main`}
            <small>
              than a merge queue at your width ·{' '}
              {timeOne === null || one.sooner === null
                ? `${sooner(one.sooner)} than one at a time, the worst case`
                : `${Math.abs(timeOne)}% ${soonerWord(one.sooner)} than one at a time, the worst case`}
            </small>
            {waited === null ? null : (
              <small>
                {sooner(queue.sooner)} each, about {hoursWords(waited)} of waiting{' '}
                {waited >= 0 ? 'saved' : 'added'} over {plural(c.landings, 'landing')} (median saving ×
                landings)
              </small>
            )}
          </div>
          <Bars
            label={`Median time to main: Forge ${duration(forgeToMain)} measured. Replayed estimates: ${name} ${duration(queue.toMainSeconds)}, one at a time ${duration(one.toMainSeconds)}.`}
            rows={[
              {
                name: 'Forge',
                value: forgeToMain === null ? '–' : clock(forgeToMain),
                share: ft!,
                kind: 'forge',
              },
              {
                name,
                hover: queueSetting(queue),
                value: queue.toMainSeconds === null ? '–' : clock(queue.toMainSeconds),
                share: qt!,
                kind: 'est',
              },
              {
                name: ONE_AT_A_TIME.name,
                hover: ONE_AT_A_TIME.setting,
                value: one.toMainSeconds === null ? '–' : clock(one.toMainSeconds),
                share: ot!,
                kind: 'est',
              },
            ]}
          />
        </div>
      </div>
      <div className="legend">
        <span>
          <i className="forge" />
          Forge, measured
        </span>
        <span>
          <i className="est" />
          Your own history replayed, an estimate
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
            We compare Forge’s recorded results with two GitHub replays of the same {plural(c.days, 'day')}.
          </p>
          <p>
            We price a replayed full run at {minutes(c.check.runnerSeconds / 60)} runner minutes. That is the
            median of {plural(c.check.runs, 'solo full check')}. Each of those checks ran in full for one
            change and passed. The median finish time is {duration(c.check.wallSeconds)}. We round the numbers
            shown here.
          </p>
          <dl className="kv">
            <dt>Forge, {minutes(c.forgeMinutes)}</dt>
            <dd>
              We add up the recorded minutes for checks that started on these days, including failed and
              discarded checks. We leave out main audits.
              {c.unknownRuns ? ` ${plural(c.unknownRuns, 'run')} reported no minutes.` : ''}
              {c.unlinked.runs
                ? ` ${plural(c.unlinked.runs, 'check')} that Stats couldn’t match to a landing count only here (${minutes(c.unlinked.minutes)} min).`
                : ''}
            </dd>
            <dt>The same on both sides</dt>
            <dd>
              Both replays use recorded minutes for checks of work that stopped before landing (
              {plural(c.notLanded.runs, 'run')}, {minutes(c.notLanded.minutes)} min). They also use recorded
              minutes for failed checks counted outside the merge queue. A failed pull-request check (
              {plural(c.failed.pullRequest, 'run')}) keeps its change out of the queue.
            </dd>
            <dt>
              {ONE_AT_A_TIME.name}, {minutes(one.ciMinutes)}
            </dt>
            <dd>
              We price one check per change and a rerun each time another change reached main while it waited
              ({plural(Math.round(one.runs), 'run')}). We add {plural(one.recordedRuns, 'run')} at their
              recorded minutes. Changes land one at a time. The checks need {percent(c.load)} of the time
              available. The wait grows when checks need more time than the day has.
            </dd>
            <dt>
              {name}, {minutes(queue.ciMinutes)}
            </dt>
            <dd>
              We replay a pull-request check and a queue build for each change that lands. Up to{' '}
              {queue.concurrency} changes build at once on top of those ahead (your project’s check
              concurrency setting), and 1 merges at a time. A failed recheck after main moves removes the
              change from the queue ({plural(c.failed.inQueue, 'check')}) and restarts the builds behind it. A
              cut-short build counts for the share it ran. That gives{' '}
              {plural(Math.round(queue.runs), 'full-check equivalent')} plus{' '}
              {plural(queue.recordedRuns, 'run')} at their recorded minutes. Waiting changes carry into the
              next day. With checks 10% faster or slower, the median time to main is{' '}
              {duration(queue.sensitivity.fast)} to {duration(queue.sensitivity.slow)}.
            </dd>
            <dt>Time to main</dt>
            <dd>
              We take the median time from “land” to main for changes that landed on those days. Forge uses
              recorded times. The GitHub setups replay the wait and checks using each day’s median solo full
              check duration, carried forward when a day has none.
            </dd>
            <dt>Left out</dt>
            <dd>
              Both sides leave out review and time before “land.” A failed recheck after main moved counts as
              a queue failure only if every change in it had passed that day. Forge counts checks still
              running or waiting to land at day’s end. The replays count the change on the day it landed.
              {w.daysWithoutRuns
                ? ` We left ${plural(w.daysWithoutRuns, 'day')} with missing run records out of the CI figures.`
                : ''}
              {w.daysWithoutSolo
                ? ` We left ${plural(w.daysWithoutSolo, 'day')} without a solo full check to use out of the comparison.`
                : ''}
            </dd>
          </dl>
          <p>
            Dollars price the minutes saved at GitHub’s list price for a {STATS_RATE_RUNNER} runner, $
            {STATS_USD_PER_RUNNER_MINUTE} a minute, read from{' '}
            <a className="lk" href={STATS_RATE_SOURCE}>
              GitHub’s pricing page
            </a>{' '}
            on {STATS_RATE_READ_ON}. Hours of waiting are the median time saved to reach main times the
            landings; they carry no money value, because that time is productivity people and agents get back.
          </p>
          <p>
            We calculate these figures from this project’s own records and use them only on Stats. Only
            signed-in project members with write access can see them.
          </p>
        </div>
      ) : null}
    </Region>
  );
}

const CAUSES = [
  ['mainMoved', 'main moved'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['superseded', 'superseded'],
] as const;

export function Measured({ w, asOf = null }: { w: StatsWindow; asOf?: string | null }) {
  const m = w.measured;
  const d = m.discarded;
  return (
    <Region title="Measured" hint={hintAsOf('facts from this project’s check runs and landings', asOf)}>
      <dl className="kv">
        <dt>CI minutes per landing</dt>
        <dd>
          {m.ciMinutesPerLanding === null
            ? m.ciMinutes === null
              ? 'Not recorded'
              : 'Not reported'
            : `${minutes(m.ciMinutesPerLanding)} min`}{' '}
          <span className="t3">
            {m.ciMinutes === null
              ? 'these days closed before Stats recorded every check run'
              : `every check run, ${plural(m.runs, 'run')}`}
            {m.unknownRuns ? `, ${int(m.unknownRuns)} without minutes` : ''}
            {m.unlinked.runs ? `, ${int(m.unlinked.runs)} not tied to a landing` : ''}
            {m.landedPathMinutesPerLanding === null
              ? ''
              : `; ${minutes(m.landedPathMinutesPerLanding)} min on the landed path alone`}
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
        {m.tokens ? (
          <>
            <dt>Agent tokens</dt>
            <dd>
              {int(Math.round(m.tokens.perLanding))} per landing{' '}
              <span className="t3">
                reported by agents, measured from {int(m.tokens.reported)} of{' '}
                {plural(m.tokens.landings, 'landing')}.{' '}
                <a className="lk" href="/docs/research/p6-exit-bench-results/">
                  The benchmark
                </a>{' '}
                compares tokens with a GitHub flow.
              </span>
            </dd>
          </>
        ) : null}
        <dt>Discarded checks</dt>
        {d === null ? (
          <dd>
            Not recorded <span className="t3">these days closed before Stats recorded every check run</span>
          </dd>
        ) : (
          <dd>
            {minutes(d.minutes)} min{' '}
            <span className="t3">
              {plural(d.runs, 'run')} that did not land
              {d.unknown ? `, ${int(d.unknown)} without minutes` : ''}
            </span>
            <ul className="stats-causes">
              {CAUSES.map(([key, label]) => (
                <li key={key}>
                  <span>{label}</span> <span className="num">{minutes(d.byCause[key].minutes)} min</span>{' '}
                  <span className="t3">
                    {plural(d.byCause[key].runs, 'run')}
                    {d.byCause[key].unknown ? `, ${int(d.byCause[key].unknown)} without minutes` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        )}
      </dl>
    </Region>
  );
}
