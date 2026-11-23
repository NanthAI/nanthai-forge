// SPDX-License-Identifier: Apache-2.0
// The Flow picture (Item 85f456c1, direction B · Works, the approved home mock): Editing, Saved, In queue, Checking and
// main as isometric platforms, one block per open Lane, Lanes checked together as one tower, main as today's landings
// hour by hour, and the two ways back to Editing. Its size steps with the width its region gives it (ResizeObserver:
// no timer, no read). A held block's tag goes to its row under Needs you, which marks itself once. A stop's name opens
// its drawer. Past the feed's cap a stop's moving Lanes are one solid, held Lanes still blocks in front. The only loops
// are the ambient exception (DESIGN.md, Motion): a dash on a track while moving work is behind it and the Lanes of a
// running check breathing, both CSS only (flow.css) and only while the region says it is live.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Glyph } from '../../ds';
import { followLink } from '../router';
import type { LineFeed } from '../Line';
import { useFlowArrival } from './motion';
import { Blocks, CubeFaces, CubeFocus, motionStyle } from './blocks';
import { blockLabel, CubeHint } from './hint';
import { BackLabel, StationLabel, Tag } from './labels';
import type { DrawerStop } from './drawer-model';
import { cubeArt, config, layout, placeBlocks, platform, strata, ISO } from './geometry';
import { shortWho, type Block, type mainHealth, type Station } from './model';

export type PictureFacts = {
  /** Landed today, landings per hour today (oldest first), and main's verdict. */
  today: number;
  hasMain: boolean;
  hours: readonly number[];
  red: boolean;
  /** The figures each label and rail says. */
  stationFacts: readonly (string | null)[];
  mainFact: ReturnType<typeof mainHealth>;
  fix: { n: number; waiting: number };
  /** main failed today: ended reds (reverted, fixed on top) and one still red that began today (Item 8d21cc9e). */
  failed: { n: number; reverted: number; fixedOnTop: number; stillRed: number };
};

/** A track's dash has the same length and speed on every rail. */
const DASH = 9;
const DASH_SPEED = 30;
function dashStyle(tx: number, ty: number, run: number, phase: number): CSSProperties {
  return {
    '--tx': `${tx.toFixed(1)}px`,
    '--ty': `${ty.toFixed(1)}px`,
    '--run': `${run.toFixed(2)}s`,
    '--lead': `${(-run * phase).toFixed(2)}s`,
  } as CSSProperties;
}

/** The picture at a width. `undefined` stations draw the empty platforms (loading). */
export function Picture({
  stations,
  facts,
  width,
  feed,
  laneHref,
  stationHref,
  revealHeld,
  loading = false,
  open,
  onOpen,
}: {
  stations: readonly Station[];
  facts: PictureFacts;
  width: number;
  feed: LineFeed | undefined;
  laneHref: (id: string) => string;
  stationHref: (stop: DrawerStop) => string;
  revealHeld: (id: string) => void;
  /** The feed has not arrived: empty platforms where the stops will stand, no counts. */
  loading?: boolean;
  /** The stop whose drawer is open. */
  open?: DrawerStop | null;
  onOpen: (stop: DrawerStop) => void;
}) {
  const c = useMemo(() => config(width), [width]);
  const big = c.t === 2;
  const short = c.t === 0;
  const geometry = useMemo(() => {
    const positions = layout(stations, facts.today, width, c);
    const blocks = new Map(
      stations.flatMap((station, i) =>
        placeBlocks(station, c, ...positions.C[i]!).map(
          p => [p.laneId, { ...p, stop: station.stop }] as const,
        ),
      ),
    );
    const [x, y] = positions.C[4]!;
    return { ...positions, blocks, mainTop: { x, y: y - positions.mainH } };
  }, [stations, facts.today, width, c]);
  const { C, d, y1, y2, height, tops, mainH, blocks, mainTop } = geometry;
  const frame = useMemo(
    () => (feed ? { feed, width, blocks, main: mainTop, today: facts.today } : undefined),
    [feed, width, blocks, mainTop, facts.today],
  );
  const arrival = useFlowArrival(frame);
  const labels = useMemo(
    () =>
      new Map(
        stations.flatMap(station =>
          station.blocks.map(block => [block.laneId, blockLabel(block, station.name)] as const),
        ),
      ),
    [stations],
  );
  const half = c.half;
  const fe = C[0]![1] + half + 12;
  const rail = (from: number, x1: number, y: number, live: boolean) => (
    <g key={`rail-${from}`}>
      <path
        className={live ? 'fv-rail live' : 'fv-rail'}
        d={`M${C[from]![0].toFixed(1)} ${(C[from]![1] + half + 8).toFixed(1)}V${y}H${x1.toFixed(1)}V${fe + 8}`}
      />
      <path
        className={live ? 'fv-arrow live' : 'fv-arrow'}
        d={`M${(x1 - 5).toFixed(1)} ${fe + 9}h10l-5 -8z`}
      />
    </g>
  );
  const main = C[4]!;
  const art = strata(main[0], main[1], half, facts.hours, mainH, facts.red);
  // A held block's tag at full size floats above it, clear of the others.
  const tags: { block: Block; left: number; top: number }[] = [];
  if (big) {
    const placed: [number, number][] = [];
    stations.forEach(station => {
      for (const block of station.held) {
        if (!block.needsYou) continue;
        const p = blocks.get(block.laneId)!;
        const w = 34 + (block.word.length + (shortWho(block.who)?.length ?? 0)) * 6.5;
        const left = Math.max(4, Math.min(p.x + c.s * 0.9, width - w - 6));
        let top = p.y - c.s - 28;
        while (placed.some(q => Math.abs(q[0] - left) < 170 && Math.abs(q[1] - top) < 23)) top -= 24;
        placed.push([left, top]);
        tags.push({ block, left, top });
      }
    });
  }
  const mainUnit = {
    n: facts.today,
    word: 'today',
    title: facts.mainFact?.title,
    fact: facts.mainFact ? (
      <span className="st" data-st={facts.mainFact.state} title={facts.mainFact.title}>
        <Glyph of={facts.mainFact.state} />
        {facts.mainFact.word}
      </span>
    ) : null,
  };
  return (
    <div className="fv-pic" data-tier={c.t} style={{ height }}>
      <CubeFocus
        width={width}
        height={height}
        role="group"
        aria-label="Where every open Lane is, from editing to main"
      >
        <g>
          {C.slice(0, -1).map(([x, y], i) => (
            <path
              key={`track-${i}`}
              className="fv-track"
              d={`M${x.toFixed(1)} ${y.toFixed(1)}L${C[i + 1]![0].toFixed(1)} ${C[i + 1]![1].toFixed(1)}`}
            />
          ))}
          {C.slice(0, -1).map(([x, y], i) => {
            // A dash runs only while the stop behind it holds moving work; constant speed, one pair per track.
            const behind = stations[i]!;
            if (behind.allBlocks.length - behind.held.length <= 0) return null;
            const dx = (C[i + 1]![0] - x) * 0.4;
            const dy = (C[i + 1]![1] - y) * 0.4;
            const len = Math.hypot(dx, dy);
            if (len < DASH) return null;
            const run = len / DASH_SPEED;
            const u = [(dx / len) * DASH, (dy / len) * DASH];
            return [0, 0.5].map(phase => (
              <path
                key={`dash-${i}-${phase}`}
                className="fv-dash"
                d={`M${(x + dx * 0.75).toFixed(1)} ${(y + dy * 0.75).toFixed(1)}l${u[0]!.toFixed(1)} ${u[1]!.toFixed(1)}`}
                style={dashStyle(dx - u[0]!, dy - u[1]!, run, phase)}
              />
            ));
          })}
          {rail(4, C[0]![0] - 9, y2, facts.red)}
          {rail(3, C[0]![0] + 9, y1, false)}
        </g>
        <g>
          {C.map(([x, y], i) => {
            const plat = platform(x, y, half);
            const zero = i < 4 ? !stations[i]!.n : !facts.hasMain;
            return (
              <g key={`plat-${i}`} className={zero ? 'fv-plat zero' : 'fv-plat'}>
                <path className="l" d={plat.l} />
                <path className="r" d={plat.r} />
                <path className="top" d={plat.top} />
              </g>
            );
          })}
          {facts.hasMain ? (
            <a
              className={`fv-strata${facts.red ? ' red' : facts.mainFact ? '' : ' unreported'}`}
              href={stationHref('main')}
              onClick={followLink}
              aria-label="main, open drawer"
            >
              {facts.mainFact ? <title>{facts.mainFact.title}</title> : null}
              <path className="l" d={art.l} />
              <path className="r" d={art.r} />
              {art.seams.map((seam, i) => (
                <path key={i} className="seam" d={seam} />
              ))}
              <path className="t" d={art.t} />
              {facts.mainFact ? <path className="g" d={art.glyph} /> : null}
              {arrival?.pulse ? <path key={arrival.pulse} className="fv-landing-pulse" d={art.t} /> : null}
            </a>
          ) : null}
        </g>
        <g>
          {stations.map((station, i) => (
            <Blocks
              key={station.stop}
              station={station}
              c={c}
              cx={C[i]![0]}
              cy={C[i]![1]}
              where={blocks}
              arrival={arrival}
              laneHref={laneHref}
              stationHref={stationHref(station.stop)}
            />
          ))}
          {arrival?.landed ? (
            <g key={arrival.pulse} aria-hidden="true" transform={`translate(${mainTop.x} ${mainTop.y})`}>
              <g className="fv-cube fv-landed" data-st="passed" style={motionStyle(arrival.landed, 0)}>
                <CubeFaces art={cubeArt(c.s)} shape="" />
              </g>
            </g>
          ) : null}
        </g>
      </CubeFocus>
      {[...stations, null].map((station, i) => {
        const [x, y] = C[i]!;
        const high = i % 2 === 0;
        const fact = station ? (facts.stationFacts[i] ?? null) : null;
        const s = station ?? {
          stop: 'checking' as const,
          name: 'main',
          n: facts.today,
          held: [],
          blocks: [],
          allBlocks: [],
          solid: 0,
          passed: 0,
          count: 0,
        };
        const unit = station ? undefined : mainUnit;
        const key: DrawerStop = station?.stop ?? 'main';
        const drawer = { stop: key, shown: open === key, go: onOpen };
        if (big) {
          const right = high ? x - (i === 4 ? half * 0.72 : half) * 2 * ISO.CX - 4 : x - 14;
          const top = high ? y - c.up - (i === 4 ? 0 : tops[i]! - half) : y + half + 16;
          return (
            <StationLabel
              key={key}
              station={s}
              facts={fact}
              big
              bare={false}
              cls="r"
              unit={unit}
              loading={loading}
              open={drawer}
              revealHeld={revealHeld}
              style={{ right: Math.round(width - right), top: Math.round(top), maxWidth: c.lw }}
            />
          );
        }
        if (high)
          return (
            <StationLabel
              key={key}
              station={s}
              facts={fact}
              big={false}
              bare={short}
              cls="inl up"
              unit={unit}
              loading={loading}
              open={drawer}
              revealHeld={revealHeld}
              style={{
                left: Math.round(x),
                bottom: Math.round(height - (y - tops[i]!) + 6),
                maxWidth: Math.round(1.73 * d - 14),
              }}
            />
          );
        return (
          <StationLabel
            key={key}
            station={s}
            facts={fact}
            big={false}
            bare={short}
            cls="inl r"
            unit={unit}
            loading={loading}
            open={drawer}
            revealHeld={revealHeld}
            style={{
              right: Math.round(width - x + 12),
              top: Math.round(y + half + 12),
              maxWidth: Math.round(1.73 * d - 30),
            }}
          />
        );
      })}
      {tags.map(({ block, left, top }) => (
        <Tag
          key={block.laneId}
          block={block}
          revealHeld={revealHeld}
          style={{ left: Math.round(left), top: Math.round(top) }}
        />
      ))}
      {!loading ? (
        <>
          <BackLabel
            label="Needs fix"
            n={facts.fix.n}
            fact={facts.fix.waiting ? `${facts.fix.waiting} waiting for its agent` : 'none waiting'}
            short={short}
            hot={false}
            style={{ left: Math.round((C[0]![0] + C[3]![0]) / 2 - (short ? 58 : 150)), top: y1 - 9 }}
          />
          <BackLabel
            label="main failed"
            n={facts.failed.n}
            fact={`${facts.failed.stillRed ? 'still red, ' : ''}${facts.failed.reverted} reverted, ${facts.failed.fixedOnTop} fixed on top`}
            short={short}
            hot={facts.red}
            style={{ left: Math.round((C[0]![0] + C[4]![0]) / 2 + (short ? -40 : 20)), top: y2 - 9 }}
          />
        </>
      ) : null}
      <CubeHint labels={labels} blocks={blocks} size={c.s} width={width} height={height} />
    </div>
  );
}

/** The picture at the width its box is given, measured on resize only (no timer). */
export function SizedPicture(props: Omit<Parameters<typeof Picture>[0], 'width'>) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={box}>{width ? <Picture {...props} width={width} /> : null}</div>;
}
