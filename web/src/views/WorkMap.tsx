import { countLabel } from '../ui/count';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { Panel } from '../ui/primitives';
import { Tooltip } from '../ui/signals';
import { age } from '../ui/status';
import type { ViewRow } from '../intents/IntentDetail';
import type { CockpitLane } from '../cockpit/model';
import './views.css';

/** A bounded window of join points; the complete history stays in the Views list. */
export function mapViews(views: readonly ViewRow[]) {
  const ordered = [...views].sort((a, b) => a.at.localeCompare(b.at));
  return {
    ordered,
    visible: ordered.length > 6 ? ordered.slice(-5) : ordered,
    earlier: ordered.length > 6 ? ordered.length - 5 : 0,
  };
}

export function candidateState(view: ViewRow) {
  if (view.accepted) return 'Accepted';
  if (view.supersededBy) return 'Superseded';
  if (view.check === 'failed') return 'Check failed';
  if (view.status === 'conflict') return 'Conflict';
  if (['running', 'queued', 'preparing'].includes(view.check ?? '')) return 'Checking';
  if (view.check === 'passed') return 'Ready';
  return 'Not checked';
}

/** Each time column pins its input saves directly above its candidate, avoiding long diagonal joins.
 * On narrow screens time runs down the page, with Lane tracks in adjacent columns. */
export function WorkMap({
  lanes,
  views,
  laneHref,
  viewHref,
  viewsHref = '#intent-views',
  title = 'Work map',
  compact = false,
  now = Date.now(),
}: {
  lanes: readonly Pick<CockpitLane, 'id' | 'name' | 'checkpoints' | 'accepted'>[];
  views: readonly ViewRow[];
  laneHref: (id: string) => string;
  viewHref?: (id: string) => string;
  viewsHref?: string;
  parentTitle?: string;
  title?: string;
  compact?: boolean;
  now?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { visible, earlier } = mapViews(views);
  const mobile = width < 760;
  const laneX = (index: number) => 24 + index * 42;
  const laneY = (index: number) => 76 + index * 48;
  const desktopStart = Math.min(190, width * 0.22);
  const eventX = (index: number) =>
    desktopStart + ((index + 0.5) * (width - desktopStart - 16)) / Math.max(1, visible.length);
  const markerY = mobile ? 0 : laneY(Math.max(0, lanes.length - 1)) + 80;
  const height = mobile ? 130 + Math.max(1, visible.length) * 76 : markerY + 90;
  const points = visible.map((view, index) => {
    const inputs = (view.inputs ?? []).filter(input => lanes.some(lane => lane.id === input.laneId));
    const latestLane = Math.max(0, ...inputs.map(input => lanes.findIndex(lane => lane.id === input.laneId)));
    return {
      view,
      inputs,
      x: mobile ? laneX(latestLane) + 24 : eventX(index),
      y: mobile ? 150 + index * 76 : markerY,
    };
  });
  const tone = (view: ViewRow) =>
    view.accepted
      ? 'accepted'
      : view.supersededBy
        ? 'old'
        : view.check === 'failed' || view.status === 'conflict'
          ? 'failed'
          : 'current';
  return (
    <Panel title={title}>
      <div className="fx-work-map" data-compact={compact || undefined} ref={ref}>
        <div className="fx-map-canvas" style={{ width, height }} data-mobile={mobile || undefined}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ width, height }}
            role="group"
            aria-label={`${lanes.length} ${lanes.length === 1 ? 'Lane' : 'Lanes'}, ${views.length} ${views.length === 1 ? 'View' : 'Views'}, ${views.filter(v => v.accepted).length} accepted; time runs ${mobile ? 'down' : 'left to right'}`}
          >
            {lanes.map((lane, i) => (
              <g key={lane.id}>
                <path
                  className="fx-map-track"
                  d={mobile ? `M${laneX(i)} 60V${height - 30}` : `M${desktopStart} ${laneY(i)}H${width - 16}`}
                />
                <a href={laneHref(lane.id)}>
                  <title>{`${lane.name} · ${countLabel(lane.checkpoints, 'save')}`}</title>
                  <text
                    className="fx-map-label"
                    x={mobile ? laneX(i) : 8}
                    y={mobile ? 20 + i * 15 : laneY(i) - 5}
                  >
                    {mobile
                      ? `${i + 1} · ${lane.name.length > 30 ? lane.name.slice(0, 29) + '…' : lane.name}`
                      : lane.name.length > 23
                        ? lane.name.slice(0, 22) + '…'
                        : lane.name}
                  </text>
                  {!mobile && (
                    <text className="fx-map-count" x="8" y={laneY(i) + 12}>
                      {countLabel(lane.checkpoints, 'save')}
                    </text>
                  )}
                </a>
              </g>
            ))}
            <path
              className="fx-map-main"
              d={
                mobile ? `M${width - 18} 60V${height - 30}` : `M${desktopStart} ${height - 25}H${width - 16}`
              }
            />
            <text x={mobile ? width - 50 : 8} y={mobile ? 50 : height - 21}>
              main
            </text>
            {points.map(({ view, inputs, x, y }) => (
              <g key={view.id} className={`fx-map-${tone(view)}`}>
                {inputs.map(input => {
                  const laneIndex = lanes.findIndex(lane => lane.id === input.laneId);
                  const sx = mobile ? laneX(laneIndex) : x;
                  const sy = mobile ? y - 26 : laneY(laneIndex);
                  return (
                    <g key={input.laneId}>
                      <path className="fx-map-join" d={`M${sx} ${sy}V${y - 14}H${x}`} />
                      <circle className="fx-map-save" cx={sx} cy={sy} r="4">
                        <title>{`${lanes[laneIndex]!.name} · pinned ${input.saveIndex == null || input.saveIndex < 0 ? 'source' : `save ${input.saveIndex + 1}`}`}</title>
                      </circle>
                    </g>
                  );
                })}
                {view.accepted && (
                  <path
                    className="fx-map-land"
                    d={mobile ? `M${x} ${y + 14}V${y + 32}H${width - 18}` : `M${x} ${y + 14}V${height - 25}`}
                  />
                )}
              </g>
            ))}
          </svg>
          {points.map(({ view, inputs, x, y }) => {
            const state = candidateState(view),
              elapsed = age(view.acceptedAt ?? view.at, now);
            const label = `${state}${elapsed && ['Accepted', 'Check failed'].includes(state) ? ` · ${elapsed}` : ''}`;
            const href = viewHref?.(view.id);
            return (
              <div
                key={view.id}
                className={`fx-map-marker fx-map-${tone(view)}`}
                style={{ left: x - 14, top: y - 14, width: mobile ? width - x - 12 : 28 }}
              >
                <Tooltip
                  placement="above"
                  offset={Math.max(0, Math.min(width - 224, x - 100)) - (x - 14)}
                  content={
                    <>
                      <strong>{state}</strong>
                      <span>{elapsed ? age(view.acceptedAt ?? view.at, now, true) : 'Time unavailable'}</span>
                      {inputs.length > 0 && (
                        <span>
                          {inputs.map(input => lanes.find(lane => lane.id === input.laneId)!.name).join(', ')}
                          {view.checkName ? ` · ${view.checkName}` : ''}
                        </span>
                      )}
                      {href && <a href={href}>Open</a>}
                    </>
                  }
                >
                  {id => (
                    <a
                      href={href}
                      aria-describedby={id}
                      aria-label={`${state}${elapsed ? ` · ${elapsed}` : ''}`}
                      className="fx-map-open"
                    >
                      <span className="fx-map-node" aria-hidden="true">
                        {view.accepted
                          ? '✓'
                          : view.supersededBy
                            ? '◇'
                            : state === 'Check failed' || state === 'Conflict'
                              ? '!'
                              : state === 'Checking'
                                ? '◷'
                                : '◆'}
                      </span>
                      <span className="fx-map-state">{label}</span>
                    </a>
                  )}
                </Tooltip>
              </div>
            );
          })}
        </div>
        {earlier > 0 && (
          <a className="fx-map-earlier" href={viewsHref}>
            {earlier} earlier
          </a>
        )}
      </div>
    </Panel>
  );
}
