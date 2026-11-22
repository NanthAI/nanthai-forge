// SPDX-License-Identifier: Apache-2.0
// The cells of one plan row and the Initiative roll-up (Items d3357f40, b7a0dff1, f49e3a5c), shared by the backlog
// and the Initiative page. Pure drawing: no reads, no state.
import { Fragment } from 'react';
import { itemStatusLabel, type PlanRow } from '../../../../src/planning-model';
import { ItemState, State, Who } from '../../ds';
import { A } from '../frames';
import { breakdownTotal, breakdownWords, type Breakdown } from '../progress';
import { statusOf, type PlanLine } from './model';
import type { Workers } from './workers';

/** Columns after the handle: position, the name with its flags, done-when, owner, status. On a phone plan.css sets
 * `--plan-cols` to the position and the name only; the name's cell then shows the status before the flags, on a line
 * under the name. */
export const COLS = 'var(--plan-cols, 2.2em minmax(0, 1fr) auto auto auto)';

export function Status({ row }: { row: PlanRow }) {
  const status = statusOf(row);
  if (status === 'proposed' || status === 'planned') return <ItemState of={status} />;
  if (status === 'in-progress') return <State word="In progress" />;
  return <State word={itemStatusLabel[status] as 'Done' | 'Abandoned' | 'Archived' | 'Deleted'} />;
}

export function DoneWhen({ row }: { row: PlanRow }) {
  // No checklist: the cell stays empty, and says so on hover and to assistive tech (owner 2026-11-19).
  if (!row.doneWhen)
    return (
      <span className="dw none" title="no checklist">
        <span className="sr">no checklist</span>
      </span>
    );
  const [ticked, total] = row.doneWhen;
  return (
    <span className="dw" title={`${ticked} of ${total} done-when lines ticked`}>
      {total <= 12 ? (
        <span className="shards" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <i key={index} className={index < ticked ? 'ok' : undefined} />
          ))}
        </span>
      ) : null}
      <span className="num">
        {ticked}/{total}
      </span>
    </span>
  );
}

/** The set owner; with none, who works on it now (open Lanes active in the last 48 hours, newest first, "+N" for
 * more); "no one yet" only when there is neither (owner 2026-11-19). */
export function Owner({
  owner,
  workers,
  whole = false,
}: {
  owner?: string | null | undefined;
  /** The whole public identity (`handle/run`), as the board shows it. */
  whole?: boolean;
  /** Public labels of the Item's active Lanes; empty when nobody; undefined when not known. */
  workers?: readonly string[] | undefined;
}) {
  if (owner) return <Who handle={owner} whole={whole} />;
  // Not asked about (past the read's cap, or before its answer): say nothing rather than a "no one yet" that may be
  // wrong.
  if (!workers) return null;
  if (!workers.length) return <span className="t3">no one yet</span>;
  const [first, ...rest] = workers;
  return (
    <span className="plan-who" title={`Working on it now: ${workers.join(', ')}`}>
      <Who handle={first!} whole={whole} />
      {rest.length ? <span className="t3 num"> +{rest.length}</span> : null}
    </span>
  );
}

/** One row's cells after the tick box. `ranked` is false under any order other than by hand, so no order number
 * suggests a hand order that is not shown. */
export function Line({
  line,
  href,
  ranked = true,
  flat = false,
  workers,
}: {
  line: PlanLine;
  href: string;
  ranked?: boolean;
  /** Who works on each Item now (workers.ts), shown when the Item has no owner. */
  workers?: Workers | undefined;
  /** List layout: sub-items sit at their parent's place without the tree's indent. */
  flat?: boolean;
}) {
  const { row } = line;
  return (
    <>
      <span className="rk" aria-hidden="true">
        {line.depth || !ranked ? '' : line.rank}
      </span>
      <span className={`tt${line.depth && !flat ? ' sub' : ''}`}>
        <A className="ttl" href={href} dir="auto" title={row.title}>
          {row.title}
        </A>
        <span className="plan-st">
          <Status row={row} />
        </span>
        {line.next ? (
          <span
            className="nextmark"
            title="The first planned Item with no owner, no Lane and nothing blocking it"
          >
            next
          </span>
        ) : null}
        {row.inLane ? <span className="flag">in Lane</span> : null}
        {line.blockedBy ? (
          <span className="flag" title={`Cannot start until ${line.blockedBy.title} is done`}>
            blocked by {line.blockedBy.id.slice(0, 4)}
          </span>
        ) : null}
        {line.shelvedInitiative ? (
          <span
            className="flag"
            title="Its Initiative was archived or deleted; the Item stays here until it moves"
          >
            Initiative archived or deleted
          </span>
        ) : null}
        {row.type ? <span className="flag">{row.type}</span> : null}
        {row.hidden ? <span className="flag">hidden</span> : null}
      </span>
      <span className="plan-wide">
        <DoneWhen row={row} />
      </span>
      <span className="plan-wide">
        <Owner owner={row.owner} workers={workers ? workers.get(row.id) : []} />
      </span>
      <span className="state">
        <Status row={row} />
      </span>
    </>
  );
}

/** Ticks a roll draws for `total` Items, at most `cap`: past the cap one tick stands for several Items. */
export const rollTicks = (total: number, cap: number) => Math.max(0, Math.min(total, cap));

/** The roll's width in px on a band: room for every tick at its widest (14 px and a 2 px gap), at most 120 px. At the
 * cap of 24 ticks 120 px still holds each tick's 2 px floor and gaps (94 px), so the ticks never spill onto the words
 * beside them (f49e3a5c: 40 ticks needed 158 px in a 120 px box). */
export const BAND_TICKS = 24;
export const bandRollWidth = (ticks: number) => Math.min(120, Math.max(0, ticks * 16 - 2));

/** One tick per Item, in the breakdown's order and colours (web/src/app/progress.ts): done, in progress, open,
 * proposed, removed (DESIGN.md roll-up; no typed percentage). Past the cap one tick stands for several Items and
 * takes the colour of the part it falls in. `large` is the Initiative page's: it takes the width it is given. */
export function Roll({ breakdown, large = false }: { breakdown: Breakdown; large?: boolean }) {
  const { total, parts } = breakdown;
  const ticks = rollTicks(total, large ? 60 : BAND_TICKS);
  const step = total / (ticks || 1);
  const tickAt = (at: number) => {
    let end = 0;
    for (const part of parts) {
      end += part.n;
      if (at < end) return part.tick;
    }
    return parts.at(-1)?.tick;
  };
  return (
    <span
      className={large ? 'roll lg' : 'roll'}
      role="img"
      aria-label={`${breakdownTotal(breakdown)}: ${breakdownWords(breakdown)}`}
      style={large ? undefined : { width: `${bandRollWidth(ticks)}px` }}
    >
      {Array.from({ length: ticks }, (_, index) => (
        <i key={index} className={tickAt(index * step)} />
      ))}
    </span>
  );
}

/** The breakdown in words, each part after a swatch of its tick's colour, in the roll's order. */
export function BreakdownWords({
  breakdown,
  responsive = false,
}: {
  breakdown: Breakdown;
  responsive?: boolean;
}) {
  return (
    <span className="plan-bd" title={breakdownTotal(breakdown)}>
      {breakdown.parts.map((part, index) => {
        const count = `${part.n.toLocaleString()}${part.atLeast ? '+' : ''}`;
        return (
          <Fragment key={part.key}>
            {/* The dot keeps to the end of a line when the words wrap. */}
            {index ? (
              <span className="plan-bsep" aria-hidden="true">
                {'\u00a0· '}
              </span>
            ) : null}
            <span className="plan-bp">
              <i className={part.tick} aria-hidden="true" />
              <span className="plan-bfull">
                {count} {part.word}
              </span>
              {responsive ? (
                <span className="plan-bcompact" role="img" aria-label={`${count} ${part.word}`} tabIndex={0}>
                  {count}
                  <span className="plan-bword">{part.word}</span>
                </span>
              ) : null}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}
