// SPDX-License-Identifier: Apache-2.0
import { passedWaiting, type LineFeed } from '../Line';
import { Roll, type RollSegment } from '../../ds';
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

/** What each running check is told on hover: what it checks, how long it has run, and the usual time to measure it by.
 * The feed has no shard progress (shards report together at the end), so a segment fills by elapsed time against the
 * day's middle landing time, and has no fill until a landing has been timed. */
export function checkSegments(
  checks: LineFeed['checks'],
  drawnAt: number,
  usual: number | null,
  passed: number,
  failed: number,
): RollSegment[] {
  const some = checks?.partial ? 'At least ' : '';
  const running = (checks?.runs ?? []).map(({ lanes, at, reserved }): RollSegment => {
    const elapsed = Math.max(0, (drawnAt - at) / 1000);
    const what = lanes === 1 ? '1 Lane' : `${some}${lanes.toLocaleString('en')} Lanes together`;
    return {
      state: 'run',
      ...(usual ? { fill: elapsed / usual } : { unknown: true as const }),
      title: [
        `Running check: ${what}`,
        `running ${duration(elapsed)}`,
        usual
          ? `landings usually take ${duration(usual)}`
          : 'no landing timed yet today, so no progress to show',
        reserved ? 'room was kept for it when it was requested' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  });
  const waiting = Array.from({ length: Math.min(passed, MAX_SEGMENTS) }, (): RollSegment => ({
    state: 'wait',
    fill: 1,
    title: 'A Lane passed its check and waits to land',
  }));
  const stopped = Array.from({ length: Math.min(failed, MAX_SEGMENTS) }, (): RollSegment => ({
    state: 'fail',
    fill: 1,
    title: 'A Lane’s check failed; its agent fixes it',
  }));
  const room = Array.from({ length: Math.min(checks?.free ?? 0, MAX_SEGMENTS) }, (): RollSegment => ({
    title: 'Room for another check to start now',
  }));
  return [...running, ...waiting, ...stopped, ...room];
}
const MAX_SEGMENTS = 12;

/** The one short line beside the bar. */
export function checksSummary(checks: LineFeed['checks'], passed: number) {
  const runs = checks?.runs.length ?? 0;
  const parts = [
    runs
      ? `${checks?.partial ? 'At least ' : ''}${runs} running`
      : checks && !checks.partial
        ? 'None running'
        : 'Running checks not reported',
    passed ? passedWaiting(passed) : null,
    checks?.free === undefined
      ? null
      : `${checks.free ? `${checks.free} more ${checks.free === 1 ? 'check' : 'checks'}` : 'No more checks'} can start now`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function FlowChecks({
  checks,
  day,
  drawnAt,
  passed,
  failed,
  open,
  onOpen,
}: {
  checks: LineFeed['checks'];
  day: ReturnType<typeof flowFigures>;
  drawnAt: number;
  passed: number;
  /** Lanes held on a failed check. */
  failed: number;
  open: boolean;
  onOpen: () => void;
}) {
  const summary = checksSummary(checks, passed);
  const segments = checkSegments(checks, drawnAt, day.samples ? (day.middle ?? null) : null, passed, failed);
  const landed = Math.max(0, day.ciMinutes - day.lostMinutes);
  return (
    <div className="flow-chk" role="group" aria-label="Checks">
      <button type="button" className="flow-check-title" aria-expanded={open} onClick={onOpen}>
        <b>Checks</b>
        <span>{summary}</span>
      </button>
      {segments.length ? (
        <div className="flow-bar">
          <Roll
            wide
            segments={segments}
            label={`Checks: ${[summary, ...segments.map(segment => segment.title)].join('; ')}`}
          />
        </div>
      ) : null}
      <div className="flow-ci">
        <b>CI minutes today</b>
        {day.ciMinutes > 0 ? (
          <span className="flow-ci-split" aria-hidden="true">
            <i className="l" style={{ flexGrow: landed }} />
            <i className="x" style={{ flexGrow: day.lostMinutes }} />
          </span>
        ) : null}
        <span className="flow-ci-key">
          <span>
            <i className="l" aria-hidden="true" />
            Landed{' '}
            <strong title={day.partial.includes('ciMinutes') ? 'Partial CI coverage' : undefined}>
              {landed.toLocaleString('en')}
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
  );
}
