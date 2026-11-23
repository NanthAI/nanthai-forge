// SPDX-License-Identifier: Apache-2.0
import { passedWaiting, type LineFeed } from '../Line';
import { Glyph, KindMark } from '../../ds';
import { CubeFaces } from './blocks';
import { cubeArt } from './geometry';
import { duration, looks, type flowFigures } from './model';

const LEGEND_BLOCK = 10;
const legendArt = cubeArt(LEGEND_BLOCK);

/** One small block for each look the picture can draw (`looks`, model.ts: the same rule the picture draws with), its
 * glyph as drawn, one short word; what it means is the hover, never permanent text (owner 2026-11-23). */
export function FlowLegend() {
  return (
    <ul className="legend flow-legend" role="list" aria-label="Lane states">
      {looks.map(({ word, colour, shape, meaning }) => (
        <li key={word} data-look={`${colour}/${shape}`} data-st={colour} title={meaning}>
          <svg
            className="fv-cube"
            data-st={colour}
            width="18"
            height="21"
            viewBox="-9 -15.5 18 21"
            aria-hidden="true"
          >
            <CubeFaces art={legendArt} shape={shape} />
          </svg>
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
