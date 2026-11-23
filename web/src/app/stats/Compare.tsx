// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats: measured beside the project's own history replayed through two GitHub setups, named by how they merge
// (Item a61d3c91; method in src/stats-estimate.ts#statsWindow), and the measured facts.
import { useState, type CSSProperties } from 'react';
import { Key, Region } from '../../ds';
import {
  clock,
  duration,
  int,
  minutes,
  gapWords,
  hintAsOf,
  partialWords,
  percent,
  plural,
  scale,
  type StatsRead,
  type StatsWindow,
} from './model';

/** The two replayed setups. `like` is the short hint under the name. `setting` gives GitHub's wording on hover. */
export const BASELINES = {
  oneAtATime: {
    name: 'One at a time',
    like: 'like GitHub with branches up to date',
    setting:
      'GitHub branch protection: “Require status checks to pass before merging” with “Require branches to be up to date before merging”',
  },
  mergeQueue: {
    name: 'Merge queue, 5 at a time',
    like: 'like GitHub merge queue',
    setting:
      'GitHub ruleset: “Require merge queue”, with “Build concurrency” (maximum pull requests to build) 5 and “Maximum pull requests to merge” 1',
  },
} as const;

const fewer = (saved: number) =>
  saved > 0 ? `${minutes(saved)} fewer` : saved < 0 ? `${minutes(-saved)} more` : 'the same';
const sooner = (s: number | null) =>
  s === null
    ? 'not replayed'
    : s > 0
      ? `${duration(s)} sooner`
      : s < 0
        ? `${duration(-s)} later`
        : 'the same';

function Axis() {
  return (
    <div className="vx stats-vx3" aria-hidden="true">
      <span>Forge</span>
      {(['oneAtATime', 'mergeQueue'] as const).map(k => (
        <span key={k} title={BASELINES[k].setting}>
          {BASELINES[k].name}
          <small>({BASELINES[k].like})</small>
        </span>
      ))}
    </div>
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
  const [fm, om, qm] = scale([c.forgeMinutes, one.ciMinutes, queue.ciMinutes]);
  // Forge's median over the same days the replays cover, so the bars and the headline agree.
  const forgeToMain = c.forgeToMainSeconds;
  const [ft, ot, qt] = scale([forgeToMain ?? 0, one.toMainSeconds ?? 0, queue.toMainSeconds ?? 0]);
  return (
    <Region
      title="Against your own history"
      hint={hintAsOf(
        'measured in this project, beside the same days replayed through two GitHub setups',
        asOf,
      )}
    >
      <div className="stats-pair">
        <div className="fig">
          <h3>CI minutes, every check run</h3>
          <div className="big">
            {fewer(queue.savedMinutes)} than a merge queue
            <small>
              {fewer(one.savedMinutes)} than one at a time, over {plural(c.landings, 'landing')}
            </small>
          </div>
          {partialWords(w) ? (
            <p className="stats-readout" role="note">
              {partialWords(w)!.saved}
            </p>
          ) : null}
          <div
            className="vb"
            role="img"
            aria-label={`CI minutes: Forge ${minutes(c.forgeMinutes)} measured. Replayed estimates: one at a time ${minutes(one.ciMinutes)}, merge queue 5 at a time ${minutes(queue.ciMinutes)}.`}
          >
            <div className="col">
              <span className="val">{minutes(c.forgeMinutes)}</span>
              <i className="forge" style={{ '--h': fm } as CSSProperties} />
            </div>
            <div className="col">
              <span className="val">{minutes(one.ciMinutes)}</span>
              <i className="est" style={{ '--h': om } as CSSProperties} />
            </div>
            <div className="col">
              <span className="val">{minutes(queue.ciMinutes)}</span>
              <i className="est" style={{ '--h': qm } as CSSProperties} />
            </div>
          </div>
          <Axis />
        </div>
        <div className="fig">
          <h3>Median time to main, from “land” to on main</h3>
          <div className="big">
            {sooner(queue.sooner)} than a merge queue
            <small>{sooner(one.sooner)} than one at a time, the worst case</small>
          </div>
          <div
            className="vb"
            role="img"
            aria-label={`Median time to main: Forge ${duration(forgeToMain)} measured. Replayed estimates: one at a time ${duration(one.toMainSeconds)}, merge queue 5 at a time ${duration(queue.toMainSeconds)}.`}
          >
            <div className="col">
              <span className="val">{forgeToMain === null ? '–' : clock(forgeToMain)}</span>
              <i className="forge" style={{ '--h': ft } as CSSProperties} />
            </div>
            <div className="col">
              <span className="val">{one.toMainSeconds === null ? '–' : clock(one.toMainSeconds)}</span>
              <i className="est" style={{ '--h': ot } as CSSProperties} />
            </div>
            <div className="col">
              <span className="val">{queue.toMainSeconds === null ? '–' : clock(queue.toMainSeconds)}</span>
              <i className="est" style={{ '--h': qt } as CSSProperties} />
            </div>
          </div>
          <Axis />
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
              {BASELINES.oneAtATime.name}, {minutes(one.ciMinutes)}
            </dt>
            <dd>
              We price one check per change and a rerun each time another change reached main while it waited
              ({plural(Math.round(one.runs), 'run')}). We add {plural(one.recordedRuns, 'run')} at their
              recorded minutes. Changes land one at a time. The checks need {percent(c.load)} of the time
              available. The wait grows when checks need more time than the day has.
            </dd>
            <dt>
              {BASELINES.mergeQueue.name}, {minutes(queue.ciMinutes)}
            </dt>
            <dd>
              We replay a pull-request check and a queue build for each change that lands. Up to 5 changes
              build at once on top of those ahead, and 1 merges at a time. A failed recheck after main moves
              removes the change from the queue ({plural(c.failed.inQueue, 'check')}) and restarts the builds
              behind it. A cut-short build counts for the share it ran. That gives{' '}
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
      {partialWords(w) ? (
        <p className="stats-readout" role="note">
          {partialWords(w)!.measured}
        </p>
      ) : null}
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
