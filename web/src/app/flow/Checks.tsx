// SPDX-License-Identifier: Apache-2.0
import { passedWaiting, type LineFeed } from '../Line';
import { Glyph, KindMark } from '../../ds';
import { duration, type flowFigures } from './model';

const legend = [
  ['Working', 'active', 'dot'],
  ['Waiting its turn', 'waiting', 'dot'],
  ['Needs you', 'waiting', 'ring'],
  ['Conflict', 'conflict', 'diamond'],
  ['Check failed', 'failed', 'square'],
] as const;

export function FlowLegend() {
  return (
    <ul className="legend flow-legend" role="list" aria-label="Lane states">
      {legend.map(([word, state, shape]) => (
        <li key={word} data-st={state}>
          <span className={shape} aria-hidden="true" />
          {word}
        </li>
      ))}
    </ul>
  );
}

export function FlowChecks({
  checks,
  day,
  drawnAt,
  passed,
  open,
  onOpen,
}: {
  checks: LineFeed['checks'];
  day: ReturnType<typeof flowFigures>;
  drawnAt: number;
  passed: number;
  open: boolean;
  onOpen: () => void;
}) {
  const runs = checks?.runs ?? [];
  return (
    <div className="flow-chk" role="group" aria-label="Checks">
      <button type="button" className="flow-check-title" aria-expanded={open} onClick={onOpen}>
        <b>Checks</b>
        <span>
          {runs.length
            ? `${checks?.partial ? 'At least ' : ''}${runs.length} running`
            : checks && !checks.partial
              ? 'None running'
              : 'Running checks not reported'}
          {passed ? ` · ${passedWaiting(passed)}` : ''}
        </span>
        {runs.length ? <span>Shards · proposed</span> : null}
      </button>
      <div className="flow-checks">
        {runs.map(({ groups, lanes, at, reserved }, index) => (
          <div key={groups.join(':')} className="flow-check">
            <b>
              <KindMark kind="check" /> Check {index + 1}
            </b>
            <span>
              {checks?.partial ? 'At least ' : ''}
              {lanes.toLocaleString('en')} {lanes === 1 ? 'Lane' : 'Lanes'}
            </span>
            <span className="st" data-st="active">
              <Glyph of="active" />
              {duration((drawnAt - at) / 1000)}
            </span>
            {reserved ? <span>Since requested</span> : null}
          </div>
        ))}
        {checks?.free === undefined ? null : (
          <div className="flow-check flow-free">
            <b>Free slots</b>
            <span>
              {checks.free} {checks.free === 1 ? 'slot' : 'slots'} in the check queue
            </span>
          </div>
        )}
        <div className="flow-check flow-ci">
          <b>CI minutes today</b>
          {day.ciMinutes > 0 ? (
            <span className="flow-ci-split" aria-hidden="true">
              <i style={{ flexGrow: Math.max(0, day.ciMinutes - day.lostMinutes) }} />
              <i style={{ flexGrow: day.lostMinutes }} />
            </span>
          ) : null}
          <span>
            <strong title={day.partial.includes('ciMinutes') ? 'Partial CI coverage' : undefined}>
              {day.ciMinutes.toLocaleString('en')}
            </strong>{' '}
            min,{' '}
            <strong title={day.partial.includes('lostMinutes') ? 'Partial coverage' : undefined}>
              {day.lostMinutes.toLocaleString('en')}
            </strong>{' '}
            on checks that did not land
          </span>
        </div>
      </div>
    </div>
  );
}
