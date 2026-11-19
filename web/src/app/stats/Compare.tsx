// SPDX-License-Identifier: Apache-2.0
// Stats: measured beside the project's own history replayed (Item a61d3c91), and the measured facts.
import { useState, type CSSProperties } from 'react';
import { Key, Region } from '../../ds';
import {
  clock,
  duration,
  int,
  minutes,
  percent,
  plural,
  scale,
  toGo,
  type StatsRead,
  type StatsWindow,
} from './model';

export function Compare({ data, w }: { data: StatsRead; w: StatsWindow }) {
  const [how, setHow] = useState(false);
  const c = w.comparison;
  if (!c)
    return (
      <Region title="Against your own history">
        <div className="empty">
          <h3>{plural(toGo(data), 'landing')} to go</h3>
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
      hint="measured in this project, beside the same days replayed through a GitHub flow"
    >
      <div className="stats-pair">
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

export function Measured({ w }: { w: StatsWindow }) {
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
