// SPDX-License-Identifier: Apache-2.0
import { useGenerationFreshness } from './generation-freshness';
import { useId } from 'react';
import { InfoTip } from './signals';
import { railStops, type RailInput } from './rail-stops';

/**
 * Journey rail: edited · saved · checked · accepted. `dim` draws a Lane nobody has been seen on
 * recently at half strength without changing its position.
 */
export function Rail({
  lane,
  size = 'sm',
  dim = false,
}: {
  lane: RailInput;
  size?: 'sm' | 'lg';
  dim?: boolean;
}) {
  const id = useId();
  const freshness = useGenerationFreshness();
  const { segments, title } = railStops(lane);
  const className = ['fx-rail', size === 'lg' && 'fx-rail-lg', (dim || freshness.behind) && 'fx-rail-dim']
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={className}
      role="img"
      tabIndex={0}
      aria-label={`Progress: ${title}`}
      aria-describedby={id}
    >
      {segments.map((segment, index) => (
        <i key={index} className={`fx-rail-${freshness.behind && segment === 'run' ? 'off' : segment}`} />
      ))}
      <span role="tooltip" id={id} className="fx-info-tip">
        <strong>
          {railState(lane)}
          {freshness.behind ? ` · ${freshness.asOf}` : ''}
        </strong>
        <br />
        Edited · saved · checked · accepted
      </span>
    </span>
  );
}

function railState(lane: RailInput) {
  if (lane.accepted) return 'Accepted';
  if (lane.tone === 'conflict') return 'Saved · conflict';
  if (lane.runStatus === 'passed') return 'Checked · not accepted';
  if (lane.runStatus && ['queued', 'preparing', 'running'].includes(lane.runStatus))
    return `Saved · check ${lane.runStatus === 'preparing' ? 'preparing' : lane.runStatus}`;
  if (lane.runStatus && ['failed', 'interrupted', 'cancelled'].includes(lane.runStatus))
    return `Saved · check ${lane.runStatus}`;
  return lane.checkpoints > 0 ? 'Saved · not checked' : 'Edited · not saved';
}

export function ProgressHeader() {
  return (
    <span>
      Progress{' '}
      <InfoTip label="Progress legend">
        Edited · saved · checked · accepted. Each bar marks one stop; a moving third bar means the check is
        running.
      </InfoTip>
    </span>
  );
}
