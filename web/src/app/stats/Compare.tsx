// SPDX-License-Identifier: Apache-2.0
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
  partialWords,
  percent,
  plural,
  scale,
  type StatsRead,
  type StatsWindow,
} from './model';

/** The two replayed setups. `like` is the short hint under the name; `setting` is GitHub's exact wording, on hover
 * and in the method. */
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

export function Compare({ w }: { data: StatsRead; w: StatsWindow }) {
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
      hint="measured in this project, beside the same days replayed through two GitHub setups"
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
            aria-label={`CI minutes: Forge ${minutes(c.forgeMinutes)} measured. Replayed: one at a time ${minutes(one.ciMinutes)}, merge queue 5 at a time ${minutes(queue.ciMinutes)}.`}
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
            aria-label={`Median time to main: Forge ${duration(forgeToMain)} measured. Replayed: one at a time ${duration(one.toMainSeconds)}, merge queue 5 at a time ${duration(queue.toMainSeconds)}.`}
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
          Your own history replayed
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
            <b>Nothing here comes from a benchmark.</b> Both replays use only this project’s own days: when
            each change was sent to land, which checks failed, and what one solo full check costs here (
            {minutes(c.check.runnerSeconds / 60)} runner minutes, {duration(c.check.wallSeconds)} to finish,
            the median of {plural(c.check.runs, 'solo full check')}). Each replayed run is priced at that.
          </p>
          <dl className="kv">
            <dt>Forge, {minutes(c.forgeMinutes)}</dt>
            <dd>
              Every check run started on these days, failed and discarded ones included; main audits are left
              out.
              {c.unknownRuns ? ` ${plural(c.unknownRuns, 'run')} reported no minutes and add none.` : ''}
              {c.unlinked.runs
                ? ` ${plural(c.unlinked.runs, 'check')} no landing attempt names (${minutes(c.unlinked.minutes)} min: run by hand, or a pre-queue check its landing did not reuse) count here only.`
                : ''}
            </dd>
            <dt>The same on both sides</dt>
            <dd>
              Work a GitHub flow runs the same way, at the minutes it took here: checks of work that was
              replaced, withdrawn or stopped ({plural(c.notLanded.runs, 'run')},{' '}
              {minutes(c.notLanded.minutes)} min), and failed checks. A change’s own failed check (
              {plural(c.failed.pullRequest, 'run')}) fails its pull-request run on GitHub and never joins the
              queue.
            </dd>
            <dt>
              {BASELINES.oneAtATime.name}, {minutes(one.ciMinutes)}
            </dt>
            <dd>
              {BASELINES.oneAtATime.setting}. One run per change and a rerun each time another change reached
              main while it waited ({plural(Math.round(one.runs), 'run')}), plus{' '}
              {plural(one.recordedRuns, 'run')} the same on both sides. Changes reach main one by one, so when
              the checks asked for are more than a day holds (here {percent(c.load)} of it) its time is a
              growing backlog: the worst case.
            </dd>
            <dt>
              {BASELINES.mergeQueue.name}, {minutes(queue.ciMinutes)}
            </dt>
            <dd>
              {BASELINES.mergeQueue.setting}. Each change runs its pull-request check, then joins the queue:
              up to 5 build at once, each on top of those ahead, and each merges on its own. A recheck that
              failed here after main moved ({plural(c.failed.inQueue, 'check')}) fails in the queue: it is
              ejected and the builds behind it start again. A build cut short by a restart counts the share of
              a check it ran: {plural(Math.round(queue.runs), 'full-check equivalent')}, plus{' '}
              {plural(queue.recordedRuns, 'run')} the same on both sides. A backlog carries into the next day
              slot by slot. With the check 10% faster or slower, its median time to main is{' '}
              {duration(queue.sensitivity.fast)} to {duration(queue.sensitivity.slow)}.
            </dd>
            <dt>Time to main</dt>
            <dd>
              From “land” to on main on both sides: on GitHub that is the pull-request check plus the queue,
              here the one check. Forge’s median here is over the same {plural(c.days, 'day')} as the replays.
            </dd>
            <dt>Left out</dt>
            <dd>
              Review time, and time spent before a change asks to land, on both sides. A failed recheck after
              main moved counts as a queue ejection only when every change on it had passed; whatever failed
              it, a flaky test included, as on GitHub. Checks still running or waiting to land when a day
              closed count on Forge’s side that day; GitHub’s side counts their change on the day it lands.
              {w.daysWithoutRuns
                ? ` ${plural(w.daysWithoutRuns, 'day')} closed before every run was counted ${w.daysWithoutRuns === 1 ? 'is' : 'are'} left out of the CI figures.`
                : ''}
              {w.daysWithoutSolo
                ? ` ${plural(w.daysWithoutSolo, 'day')} with no solo full check to price ${w.daysWithoutSolo === 1 ? 'is' : 'are'} left out of the comparison.`
                : ''}
            </dd>
          </dl>
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

export function Measured({ w }: { w: StatsWindow }) {
  const m = w.measured;
  const d = m.discarded;
  return (
    <Region title="Measured" hint="facts from this project’s check runs and landings">
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
