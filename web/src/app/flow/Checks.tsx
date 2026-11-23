// SPDX-License-Identifier: Apache-2.0
import { passedWaiting, type LineFeed } from '../Line';
import { Glyph, KindMark } from '../../ds';
import { CONFLICT_MEANING, SHARED_FILE_MEANING } from '../lane-state';
import { duration, type flowFigures } from './model';

/** The last word is the meaning, said on hover; Conflict says it in the legend itself (owner 2026-11-23): its changes
 * clash with another Lane's, and a Lane that only shares a file is not marked. */
const legend = [
  ['Working', 'active', 'dot', 'A Lane is being worked on or its check is running.'],
  ['Waiting its turn', 'waiting', 'dot', 'A Lane is queued or waits for another to land.'],
  ['Needs you', 'waiting', 'ring', 'A Lane waits for your approval or an answer.'],
  [
    'Conflict',
    'conflict',
    'diamond',
    `${CONFLICT_MEANING[0]!.toUpperCase()}${CONFLICT_MEANING.slice(1)}. ${SHARED_FILE_MEANING}`,
  ],
  ['Check failed', 'failed', 'square', 'A Lane’s check failed; its agent fixes it.'],
] as const;

export function FlowLegend() {
  return (
    <ul className="legend flow-legend" role="list" aria-label="Lane states">
      {legend.map(([word, state, shape, meaning]) => (
        <li key={word} data-st={state} title={meaning}>
          <span className={shape} aria-hidden="true" />
          {word}
          {state === 'conflict' ? (
            <>
              {' '}
              <small>· {meaning}</small>
            </>
          ) : null}
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
              <i className="l" style={{ flexGrow: Math.max(0, day.ciMinutes - day.lostMinutes) }} />
              <i className="x" style={{ flexGrow: day.lostMinutes }} />
            </span>
          ) : null}
          <span className="flow-ci-key">
            <span>
              <i className="l" aria-hidden="true" />
              Landed{' '}
              <strong title={day.partial.includes('ciMinutes') ? 'Partial CI coverage' : undefined}>
                {Math.max(0, day.ciMinutes - day.lostMinutes).toLocaleString('en')}
              </strong>{' '}
              min
            </span>
            <span>
              <i className="x" aria-hidden="true" />
              Did not land{' '}
              <strong title={day.partial.includes('lostMinutes') ? 'Partial coverage' : undefined}>
                {day.lostMinutes.toLocaleString('en')}
              </strong>{' '}
              min
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
