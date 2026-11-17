// SPDX-License-Identifier: Apache-2.0
// The cells of one plan row and the Initiative roll-up (Items d3357f40, b7a0dff1, f49e3a5c), shared by the backlog
// and the Initiative page. Pure drawing: no reads, no state.
import type { PlanRow } from '../../../../src/planning-model';
import { ItemState, State, Who } from '../../ds';
import { A } from '../frames';
import { statusOf, type PlanLine } from './model';

/** Columns after the handle: position, the name with its flags, done-when, owner, status. */
export const COLS = '2.2em minmax(0, 1fr) auto auto auto';

export function Status({ row }: { row: PlanRow }) {
  const status = statusOf(row);
  if (status === 'proposed' || status === 'planned') return <ItemState of={status} />;
  if (status === 'in-progress') return <State word="In progress" />;
  return <State word={status === 'done' ? 'Done' : 'Abandoned'} />;
}

export function DoneWhen({ row }: { row: PlanRow }) {
  if (!row.doneWhen) return <span className="dw t3">none</span>;
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

/** One row's cells after the tick box. `ranked` is false under any order other than by hand, so no order number
 * suggests a hand order that is not shown. */
export function Line({
  line,
  href,
  ranked = true,
  flat = false,
}: {
  line: PlanLine;
  href: string;
  ranked?: boolean;
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
        {line.next ? (
          <span
            className="nextmark"
            title="The first planned Item with no owner, no Lane and nothing blocking it"
          >
            next
          </span>
        ) : null}
        {line.blockedBy ? (
          <span className="flag" title={`Cannot start until ${line.blockedBy.title} is done`}>
            blocked by {line.blockedBy.id.slice(0, 4)}
          </span>
        ) : null}
        {row.type ? <span className="flag">{row.type}</span> : null}
        {row.hidden ? <span className="flag">hidden</span> : null}
      </span>
      <span className="plan-wide">
        <DoneWhen row={row} />
      </span>
      <span className="plan-wide">
        {row.owner ? <Who handle={row.owner} /> : <span className="t3">no one yet</span>}
      </span>
      <span className="state">
        <Status row={row} />
      </span>
    </>
  );
}

export type Counted = { done: number; inProgress: number; total: number };

/** Ticks a roll draws for `total` Items, at most `cap`: past the cap one tick stands for several Items. */
export const rollTicks = (total: number, cap: number) => Math.max(0, Math.min(total, cap));

/** The roll's width in px on a band: room for every tick at its widest (14 px and a 2 px gap), at most 120 px. At the
 * cap of 24 ticks 120 px still holds each tick's 2 px floor and gaps (94 px), so the ticks never spill onto the words
 * beside them (f49e3a5c: 40 ticks needed 158 px in a 120 px box). */
export const BAND_TICKS = 24;
export const bandRollWidth = (ticks: number) => Math.min(120, Math.max(0, ticks * 16 - 2));

/** One tick per Item: done, in progress, not started (DESIGN.md roll-up; no typed percentage). `large` is the
 * Initiative page's: it takes the width it is given. */
export function Roll({ counted, large = false }: { counted: Counted; large?: boolean }) {
  const { total, done, inProgress } = counted;
  const ticks = rollTicks(total, large ? 60 : BAND_TICKS);
  const step = total / (ticks || 1);
  return (
    <span
      className={large ? 'roll lg' : 'roll'}
      role="img"
      aria-label={`${done.toLocaleString()} of ${total.toLocaleString()} done, ${inProgress.toLocaleString()} in progress`}
      style={large ? undefined : { width: `${bandRollWidth(ticks)}px` }}
    >
      {Array.from({ length: ticks }, (_, index) => (
        <i
          key={index}
          className={index * step < done ? 'ok' : index * step < done + inProgress ? 'run' : undefined}
        />
      ))}
    </span>
  );
}
