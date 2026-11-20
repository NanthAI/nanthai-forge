// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from 'react';
import { Glyph } from '../../ds';
import type { DrawerStop } from './drawer-model';
import { shortWho, type Block, type Station } from './model';

/** Go to a held Lane's row under Needs you; the row marks itself once. */
export function jumpToRow(laneId: string) {
  const row = document.getElementById(`d-${laneId}`);
  if (!row) return false;
  const folded = row.closest<HTMLDetailsElement>('details.sumdec');
  if (folded) folded.open = true;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  row.classList.remove('flow-here');
  void row.offsetWidth;
  row.classList.add('flow-here');
  return true;
}

export function Tag({
  block,
  style,
  revealHeld,
}: {
  block: Block;
  style?: CSSProperties;
  revealHeld: (laneId: string) => void;
}) {
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
        event.preventDefault();
        revealHeld(block.laneId);
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

export function StationLabel({
  station,
  facts,
  big,
  bare,
  cls,
  style,
  unit,
  loading,
  open,
  revealHeld,
}: {
  station: Station;
  facts: string | null;
  big: boolean;
  /** The smallest size: name and count only. */
  bare: boolean;
  cls: string;
  style: CSSProperties;
  unit?: { n: number; word: string; fact: React.ReactNode };
  loading: boolean;
  /** Opens this stop's drawer. */
  open: { stop: DrawerStop; shown: boolean; go: (stop: DrawerStop) => void };
  revealHeld: (laneId: string) => void;
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
      <button
        type="button"
        className="flow-stop"
        aria-expanded={open.shown}
        onClick={() => open.go(open.stop)}
      >
        <span className="n">{station.name}</span>
        <span className="c num">
          {loading ? '–' : n.toLocaleString('en')}
          {unit && !loading ? <small>{unit.word}</small> : null}
        </span>
      </button>
      {!bare && (facts || unit?.fact) ? <span className="f">{unit ? unit.fact : facts}</span> : null}
      {!big && tagged.length ? (
        <span className="tags">
          {tagged.slice(0, 2).map(block => (
            <Tag key={block.laneId} block={block} revealHeld={revealHeld} />
          ))}
          {tagged.length > 2 ? <span className="more">and {tagged.length - 2} more</span> : null}
        </span>
      ) : null}
    </div>
  );
}

export function BackLabel({
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
