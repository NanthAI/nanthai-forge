// SPDX-License-Identifier: Apache-2.0
import { Component, createRef, type CSSProperties, type SVGProps } from 'react';
import { followLink } from '../router';
import { cubeArt, solid, solidHeight, type Config } from './geometry';
import type { DrawnBlock, useFlowArrival } from './motion';
import { blockLabel } from './hint';
import type { Look, Station } from './model';

/** Preserve focus when a live move reparents a Lane's link to its new platform. */
export class CubeFocus extends Component<SVGProps<SVGSVGElement>> {
  private readonly drawing = createRef<SVGSVGElement>();

  getSnapshotBeforeUpdate() {
    const active = document.activeElement;
    return active && this.drawing.current?.contains(active) ? active.getAttribute('data-id') : null;
  }

  componentDidUpdate(_props: SVGProps<SVGSVGElement>, _state: unknown, focused: string | null) {
    if (!focused || document.activeElement?.getAttribute('data-id') === focused) return;
    this.drawing.current
      ?.querySelector<SVGAElement>(`a[data-id="${CSS.escape(focused)}"]`)
      ?.focus({ preventScroll: true });
  }

  render() {
    return <svg {...this.props} ref={this.drawing} />;
  }
}

export function CubeFaces({ art, shape }: { art: ReturnType<typeof cubeArt>; shape: Look['shape'] }) {
  return (
    <>
      <path className="l" d={art.l} />
      <path className="r" d={art.r} />
      <path className="t" d={art.t} />
      {shape === 'waiting' ? <path className="hole" d={art.hole} /> : null}
      {shape === 'failed' ? <path className="g" d={art.cross} /> : null}
      {shape === 'conflict' ? <path className="g" d={art.dia} /> : null}
    </>
  );
}

type Arrival = NonNullable<ReturnType<typeof useFlowArrival>>;
export const motionStyle = ({ x, y }: { x: number; y: number }, i: number) =>
  ({
    '--from-x': `${x}px`,
    '--from-y': `${y}px`,
    '--arrival-offset': `${Math.min(240, i * 40)}ms`,
  }) as CSSProperties;

export function Blocks({
  station,
  c,
  cx,
  cy,
  where,
  arrival,
  laneHref,
  stationHref,
}: {
  station: Station;
  c: Config;
  cx: number;
  cy: number;
  where: Map<string, DrawnBlock>;
  arrival: Arrival | undefined;
  laneHref: (id: string) => string;
  stationHref: string;
}) {
  const art = cubeArt(c.s);
  const column = station.solid ? solid(cx, cy, c, solidHeight(station, c)) : null;
  return (
    <g data-stop={station.stop}>
      {column ? (
        <a
          className="fv-solid"
          href={stationHref}
          onClick={followLink}
          data-st={station.stop === 'queued' ? 'waiting' : 'active'}
          data-n={station.solid}
          aria-label={`${station.name}: ${station.solid.toLocaleString('en')} Lanes, open drawer`}
        >
          <title>{`${station.solid.toLocaleString('en')} Lanes at ${station.name}`}</title>
          <path className="l" d={column.l} />
          <path className="r" d={column.r} />
          <path className="t" d={column.t} />
        </a>
      ) : null}
      {station.blocks.map((block, i) => {
        const p = where.get(block.laneId)!;
        const moving = arrival?.blocks.get(block.laneId);
        const label = blockLabel(block, station.name);
        return (
          <g key={block.laneId} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}>
            <g
              key={moving?.key ?? 'rest'}
              className={moving ? (moving.fresh ? 'fv-enter' : 'fv-arrive') : undefined}
              style={moving ? motionStyle(moving, i) : undefined}
            >
              <a
                className={block.running ? 'fv-cube run' : 'fv-cube'}
                data-id={block.laneId}
                data-st={block.colour}
                href={laneHref(block.laneId)}
                onClick={followLink}
                aria-label={label}
              >
                <CubeFaces art={art} shape={block.shape} />
              </a>
            </g>
          </g>
        );
      })}
    </g>
  );
}
