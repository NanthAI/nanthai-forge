// SPDX-License-Identifier: Apache-2.0
// The Flow picture (Item 85f456c1, direction B · Works, the approved home mock): Editing, Saved, In queue, Checking and
// main as isometric platforms, one block per open Lane, Lanes checked together as one tower, main as today's landings
// hour by hour, and the two ways back to Editing. Its size steps with the width its region gives it (ResizeObserver:
// no timer, no read). A held block's tag goes to its row under Needs you, which marks itself once. Nothing loops here.
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Glyph } from '../../ds';
import { cubeArt, config, layout, placeBlocks, platform, strata, ISO, type Config } from './geometry';
import { shortWho, type Block, type Station } from './model';

export type PictureFacts = {
  /** Landed today, landings per hour today (oldest first), and main's verdict. */
  today: number;
  hours: readonly number[];
  red: boolean;
  /** The figures each label and rail says. */
  stationFacts: readonly (string | null)[];
  mainFact: { word: 'Passing' | 'Failing'; since: string | null } | null;
  fix: { n: number; waiting: number };
  failed: { n: number; reverted: number; fixedOnTop: number };
};

/** Go to a held Lane's row under Needs you; the row marks itself once. */
export function jumpToRow(laneId: string) {
  const row = document.getElementById(`d-${laneId}`);
  if (!row) return false;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  row.classList.remove('flow-here');
  void row.offsetWidth;
  row.classList.add('flow-here');
  return true;
}

function Tag({ block, style }: { block: Block; style?: CSSProperties }) {
  const who = shortWho(block.who);
  const words = (
    <>
      <Glyph of={block.colour} size={11} />
      {block.word}
      {who && style ? (
        <span translate="no" dir="auto">
          {who}
        </span>
      ) : null}
    </>
  );
  const title = [block.head, block.who].filter(Boolean).join(' · ') || undefined;
  return block.needsYou ? (
    <a
      className="fv-tag"
      data-st={block.colour}
      data-for={block.laneId}
      href={`#d-${block.laneId}`}
      style={style}
      title={title}
      onClick={event => {
        if (jumpToRow(block.laneId)) event.preventDefault();
      }}
    >
      {words}
    </a>
  ) : (
    <span className="fv-tag" data-st={block.colour} style={style} title={title}>
      {words}
    </span>
  );
}

function Label({
  station,
  facts,
  big,
  bare,
  cls,
  style,
  unit,
}: {
  station: Station;
  facts: string | null;
  big: boolean;
  /** The smallest size: name and count only. */
  bare: boolean;
  cls: string;
  style: CSSProperties;
  unit?: { n: number; word: string; fact: React.ReactNode };
}) {
  const n = unit ? unit.n : station.n;
  // Only a Lane that waits on the reader carries a tag: it links to its row under Needs you. Other held Lanes keep
  // their colour and glyph, and say why on hover.
  const tagged = station.held.filter(block => block.needsYou);
  return (
    <div
      className={`fv-stn ${cls}${n ? '' : ' zero'}`}
      style={style}
      data-stop={unit ? 'main' : station.stop}
    >
      <span className="n">{station.name}</span>
      <span className="c num">
        {n.toLocaleString('en')}
        {unit ? <small>{unit.word}</small> : null}
      </span>
      {!bare && (facts || unit?.fact) ? <span className="f">{unit ? unit.fact : facts}</span> : null}
      {!big && tagged.length ? (
        <span className="tags">
          {tagged.slice(0, 2).map(block => (
            <Tag key={block.laneId} block={block} />
          ))}
          {tagged.length > 2 ? <span className="more">and {tagged.length - 2} more</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function Blocks({ station, c, cx, cy }: { station: Station; c: Config; cx: number; cy: number }) {
  const art = cubeArt(c.s);
  const where = new Map(placeBlocks(station, c, cx, cy).map(p => [p.laneId, p]));
  return (
    <g data-stop={station.stop}>
      {station.blocks.map(block => {
        const p = where.get(block.laneId)!;
        return (
          <g
            key={block.laneId}
            className="fv-cube"
            data-id={block.laneId}
            data-st={block.colour}
            transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
          >
            <title>
              {[block.head ?? `Lane ${block.laneId.slice(0, 8)}`, block.who, block.word]
                .filter(Boolean)
                .join(' · ')}
            </title>
            <path className="l" d={art.l} />
            <path className="r" d={art.r} />
            <path className="t" d={art.t} />
            {block.shape === 'waiting' ? (
              <path className="hole" d={art.hole} />
            ) : block.shape === 'failed' ? (
              <path className="g" d={art.cross} />
            ) : block.shape === 'conflict' ? (
              <path className="g" d={art.dia} />
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

/** The picture at a width. `undefined` stations draw the empty platforms (loading). */
export function Picture({
  stations,
  facts,
  width,
}: {
  stations: readonly Station[];
  facts: PictureFacts;
  width: number;
}) {
  const c = config(width);
  const big = c.t === 2;
  const short = c.t === 0;
  const { C, d, y1, y2, height, tops, mainH } = layout(stations, facts.today, width, c);
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
    stations.forEach((station, i) => {
      const where = new Map(placeBlocks(station, c, C[i]![0], C[i]![1]).map(p => [p.laneId, p]));
      for (const block of station.held) {
        if (!block.needsYou) continue;
        const p = where.get(block.laneId)!;
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
    fact: facts.mainFact ? (
      <>
        <span className="st" data-st={facts.mainFact.word === 'Failing' ? 'failed' : 'passed'}>
          <Glyph of={facts.mainFact.word === 'Failing' ? 'failed' : 'passed'} />
          {facts.mainFact.word}
        </span>
        {facts.mainFact.since ? <span>since {facts.mainFact.since}</span> : null}
      </>
    ) : null,
  };
  return (
    <div className="fv-pic" data-tier={c.t} style={{ height }}>
      <svg
        width={width}
        height={height}
        role="img"
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
          {rail(4, C[0]![0] - 9, y2, facts.red)}
          {rail(3, C[0]![0] + 9, y1, false)}
        </g>
        <g>
          {C.map(([x, y], i) => {
            const plat = platform(x, y, half);
            const zero = i < 4 && !stations[i]!.n;
            return (
              <g key={`plat-${i}`} className={zero ? 'fv-plat zero' : 'fv-plat'}>
                <path className="l" d={plat.l} />
                <path className="r" d={plat.r} />
                <path className="top" d={plat.top} />
              </g>
            );
          })}
          <g className={facts.red ? 'fv-strata red' : 'fv-strata'}>
            <path className="l" d={art.l} />
            <path className="r" d={art.r} />
            {art.seams.map((seam, i) => (
              <path key={i} className="seam" d={seam} />
            ))}
            <path className="t" d={art.t} />
            <path className="g" d={art.glyph} />
          </g>
        </g>
        <g>
          {stations.map((station, i) => (
            <Blocks key={station.stop} station={station} c={c} cx={C[i]![0]} cy={C[i]![1]} />
          ))}
        </g>
      </svg>
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
          checks: [],
          passed: 0,
        };
        const unit = station ? undefined : mainUnit;
        const key = station?.stop ?? 'main';
        if (big) {
          const right = high ? x - (i === 4 ? half * 0.72 : half) * 2 * ISO.CX - 4 : x - 14;
          const top = high ? y - c.up - (i === 4 ? 0 : tops[i]! - half) : y + half + 16;
          return (
            <Label
              key={key}
              station={s}
              facts={fact}
              big
              bare={false}
              cls="r"
              unit={unit}
              style={{ right: Math.round(width - right), top: Math.round(top), maxWidth: c.lw }}
            />
          );
        }
        if (high)
          return (
            <Label
              key={key}
              station={s}
              facts={fact}
              big={false}
              bare={short}
              cls="inl up"
              unit={unit}
              style={{
                left: Math.round(x),
                bottom: Math.round(height - (y - tops[i]!) + 6),
                maxWidth: Math.round(1.73 * d - 14),
              }}
            />
          );
        return (
          <Label
            key={key}
            station={s}
            facts={fact}
            big={false}
            bare={short}
            cls="inl r"
            unit={unit}
            style={{
              right: Math.round(width - x + 12),
              top: Math.round(y + half + 12),
              maxWidth: Math.round(1.73 * d - 30),
            }}
          />
        );
      })}
      {tags.map(({ block, left, top }) => (
        <Tag key={block.laneId} block={block} style={{ left: Math.round(left), top: Math.round(top) }} />
      ))}
      <Back
        label="Needs fix"
        n={facts.fix.n}
        fact={facts.fix.waiting ? `${facts.fix.waiting} waiting for its agent` : 'none waiting'}
        short={short}
        hot={false}
        style={{ left: Math.round((C[0]![0] + C[3]![0]) / 2 - (short ? 58 : 150)), top: y1 - 9 }}
      />
      <Back
        label="main failed"
        n={facts.failed.n}
        fact={`${facts.failed.reverted} reverted, ${facts.failed.fixedOnTop} fixed on top`}
        short={short}
        hot={facts.red}
        style={{ left: Math.round((C[0]![0] + C[4]![0]) / 2 + (short ? -40 : 20)), top: y2 - 9 }}
      />
    </div>
  );
}

function Back({
  label,
  n,
  fact,
  short,
  hot,
  style,
}: {
  label: string;
  n: number;
  fact: string;
  short: boolean;
  hot: boolean;
  style: CSSProperties;
}) {
  return (
    <span className={hot ? 'fv-back hot' : 'fv-back'} style={style}>
      {label} <b>{n.toLocaleString('en')}</b> today{short ? null : <span className="t3">· {fact}</span>}
    </span>
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
