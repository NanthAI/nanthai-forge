// SPDX-License-Identifier: Apache-2.0
// The shared parts that need no behaviour library: keys, rows, bands, regions with folds that remember, the first
// stop's edge, chips, the phone tabs, tables, the Markdown and diff containers and the standing line. Rules for
// choosing each: DESIGN.md. They render at first paint; the interactive parts are in ds/interactive.tsx.
import { useCallback, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { useFirstStop } from './first-stop';
import { Count, Glyph, type StateKind } from './marks';
import './review.css';
import './public.css';
import './figures.css';

type Weight = 'act' | 'watch' | 'ref';
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export type KeyProps = ComponentPropsWithoutRef<'button'> & {
  kind?: 'primary' | 'rec' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
  /** The key that does the same, shown on the key on a wide screen (hidden on a phone). */
  keys?: string;
};

/** A button. One primary per screen; danger only for what cannot be undone (DESIGN.md). */
export function Key({ kind, size, keys, className, children, type = 'button', ...rest }: KeyProps) {
  return (
    <button type={type} className={cx('btn', kind, size, className)} {...rest}>
      {children}
      {keys ? <kbd aria-hidden="true">{keys}</kbd> : null}
    </button>
  );
}

const STORE = 'forge.fold.';
function readFold(id: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(STORE + id);
    return value === null ? fallback : value === 'open';
  } catch {
    return fallback;
  }
}

/** Open or shut, remembered on this browser per fold id. Written only when the reader folds; nothing else is stored. */
export function useFold(id: string | undefined, openByDefault = true): [boolean, () => void] {
  const [open, setOpen] = useState(() => (id ? readFold(id, openByDefault) : openByDefault));
  const toggle = useCallback(() => {
    setOpen(was => {
      const next = !was;
      if (id)
        try {
          localStorage.setItem(STORE + id, next ? 'open' : 'shut');
        } catch {
          // a private window keeps the fold for this visit only
        }
      return next;
    });
  }, [id]);
  return [open, toggle];
}

export type RegionProps = {
  title: string;
  /** Heading level inside the page: h2 by default. */
  level?: 2 | 3;
  weight?: Weight;
  /** What waits on the reader here, for the first stop's beat (only with weight "act"). */
  waiting?: string | number;
  count?: number;
  countAtLeast?: boolean;
  hint?: ReactNode;
  /** A one-line summary shown while folded. */
  sum?: ReactNode;
  /** Remembered fold: the region can be folded and this id keeps it across visits. */
  fold?: string;
  foldedByDefault?: boolean;
  /** The fold held by the screen (`useFold` with the same id), when what the region reads waits for it to open. */
  foldState?: [boolean, () => void];
  quiet?: boolean;
  tools?: ReactNode;
  /** The dock's handle, drawn first in the head. */
  handle?: ReactNode;
  children?: ReactNode;
};

/** A region: one surface, a head with its name and count, then bands and rows separated by seams. */
export function Region({
  title,
  level = 2,
  weight,
  waiting = 0,
  count,
  countAtLeast = false,
  hint,
  sum,
  fold,
  foldedByDefault = false,
  foldState,
  quiet,
  tools,
  handle,
  children,
}: RegionProps) {
  const own = useFold(foldState ? undefined : fold, !foldedByDefault);
  const [open, toggle] = foldState ?? own;
  const first = useFirstStop<HTMLElement>(weight === 'act' ? waiting : 'none');
  const H = level === 2 ? 'h2' : 'h3';
  const bodyId = fold ? `fold-${fold}` : undefined;
  return (
    <section
      ref={weight === 'act' ? first : undefined}
      className={cx('region', quiet && 'quiet', fold && !open && 'shut')}
      data-weight={weight}
      aria-label={title}
    >
      <div className={cx('ph', !handle && 'plain')}>
        {handle}
        <H>
          {fold ? (
            <button
              type="button"
              className="fold"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={toggle}
            >
              {title}
            </button>
          ) : (
            title
          )}
        </H>
        {count === undefined ? null : <Count n={count} hot={weight === 'act'} atLeast={countAtLeast} />}
        {sum ? <span className="sum">{sum}</span> : null}
        {hint ? <span className="hint">{hint}</span> : null}
        {tools ? <span className="tools">{tools}</span> : null}
      </div>
      <div id={bodyId} hidden={fold ? !open : undefined} className="rbody">
        {children}
      </div>
    </section>
  );
}

/** A band names a group inside a region: "Needs you 1, held until a person decides". */
export function Band({
  title,
  count,
  hint,
  needs,
}: {
  title: string;
  count?: number;
  hint?: ReactNode;
  needs?: boolean;
}) {
  return (
    <div className={cx('band', needs && 'needs')}>
      <span>{title}</span>
      {count === undefined ? null : <Count n={count} hot={needs} />}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** A group of rows under a heading that folds, for a list grouped by state or by person ("Held 1, stopped until its
 * agent or holder acts"). The heading is a real heading with the whole band as its key; the fold is remembered on this
 * browser per `id` (`useFold`) and costs no request. Folded, the band keeps its title and count and drops the hint. */
export function Group({
  id,
  title,
  count,
  hint,
  needs,
  label,
  role,
  children,
}: {
  /** The fold's id, kept per browser: name the screen and the group ("lanes.held"). */
  id: string;
  title: string;
  count?: number;
  hint?: ReactNode;
  needs?: boolean;
  /** The accessible name of the list the rows form, when it differs from the title. */
  label?: string;
  /** The rows' own role (`list` when each is a `listitem`). */
  role?: 'list';
  children?: ReactNode;
}) {
  const [open, toggle] = useFold(id, true);
  // An id never holds a space (aria-controls reads it as several), whatever the caller names the group.
  const bodyId = `fold-${id.replace(/\s+/g, '-')}`;
  return (
    <div className={cx('grp', !open && 'shut')} data-fold="">
      <div className={cx('band', 'fold', needs && 'needs')}>
        <h3 className="bt">
          <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
            <span className="tw" aria-hidden="true" />
            {title}
          </button>
        </h3>
        {count === undefined ? null : <Count n={count} hot={needs} />}
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      <div id={bodyId} role={role} aria-label={role ? (label ?? title) : undefined}>
        {children}
      </div>
    </div>
  );
}

/** The default row columns: a mark, the name taking the room, then the facts at their own width. */
export const ROW_COLS = 'auto minmax(0, 1fr) auto auto';

/** A row: the name first, then the facts. `cols` is its column template; `selected` is the row the reader is on. */
export function Row({
  selected,
  weight,
  dense,
  cols = ROW_COLS,
  className,
  style,
  children,
  ...rest
}: ComponentPropsWithoutRef<'div'> & {
  selected?: boolean;
  weight?: Weight;
  dense?: boolean;
  cols?: string;
}) {
  return (
    <div
      className={cx('row', selected && 'sel', dense && 'dense', className)}
      data-weight={weight}
      style={{ gridTemplateColumns: cols, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A filter or a picked value. With `onRemove` it has its own small key to take it off. */
export function Chip({
  label,
  value,
  off,
  onRemove,
}: {
  label: string;
  value?: string;
  off?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span className={cx('chip', off && 'off')}>
      <span>
        {label}
        {value ? <i>: {value}</i> : null}
      </span>
      {onRemove ? (
        <button type="button" aria-label={`Remove ${label}${value ? ` ${value}` : ''}`} onClick={onRemove}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

/** The phone's five places along the bottom edge; the current one is marked for assistive tech as well as drawn. */
export function PhoneTabs({
  places,
}: {
  places: readonly { href: string; label: string; icon: ReactNode; current?: boolean }[];
}) {
  return (
    <nav className="tabs" aria-label="Places">
      {places.map(place => (
        <a key={place.href} href={place.href} aria-current={place.current ? 'page' : undefined}>
          {place.icon}
          {place.label}
        </a>
      ))}
    </nav>
  );
}

export type Column<T> = { key: string; title: string; numeric?: boolean; cell: (row: T) => ReactNode };

/** A table that scrolls sideways inside itself on a narrow screen, never the page. */
export function Table<T>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
}) {
  return (
    <div className="scroll" role="region" aria-label={caption} tabIndex={0}>
      <table className="tbl">
        <caption className="sr">{caption}</caption>
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column.key} scope="col" className={column.numeric ? 'r' : undefined}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={rowKey(row)}>
              {columns.map(column => (
                <td key={column.key} className={column.numeric ? 'r num' : undefined}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rendered Markdown (a README, an Item's text): readable measure and the system's type. The caller's renderer draws
 * the elements inside; this is only the container. */
export function Prose({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="md" aria-label={label}>
      {children}
    </div>
  );
}

/** A diff or code block: mono, numbered, scrolling inside itself. */
export function CodeBox({ label, by, children }: { label: string; by?: boolean; children: ReactNode }) {
  return (
    <div className={by ? 'code by' : 'code'} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** `atLeast`: the figure is a lower bound (a capped read), shown "N+", never as a bare number. */
export type StandingCell = { n: number; atLeast?: boolean; more?: ReactNode; href?: string };
export type StandingProps = {
  /** "app": Items, with landings and Lanes as the secondary line. "public": landings this week, open Lanes, open Items. */
  of: 'app' | 'public';
  done: StandingCell;
  inProgress: StandingCell;
  left: StandingCell;
};

const UNITS = {
  app: { done: ['Item', 'Items'], inProgress: ['Item', 'Items'], left: ['Item', 'Items'] },
  public: {
    done: ['landing this week', 'landings this week'],
    inProgress: ['open Lane', 'open Lanes'],
    left: ['open Item', 'open Items'],
  },
} as const;

/** Where the project stands: Done, In progress, Left. Every main screen answers this (DESIGN.md rule 44). */
export function Standing({ of, done, inProgress, left }: StandingProps) {
  const units = UNITS[of];
  const total = done.n + inProgress.n + left.n;
  const amount = (n: number, atLeast?: boolean) => `${n.toLocaleString()}${atLeast ? '+' : ''}`;
  const ticks = Math.min(total, 60);
  const step = total / (ticks || 1);
  const cell = (
    word: string,
    st: StateKind,
    glyph: StateKind | 'planned',
    value: StandingCell,
    unit: readonly [string, string],
  ) => {
    const body = (
      <>
        <span className="st" data-st={st}>
          <Glyph of={glyph} />
          {word}
        </span>
        <b>{amount(value.n, value.atLeast)}</b>
        <span>{value.n === 1 && !value.atLeast ? unit[0] : unit[1]}</span>
        {value.more ? (
          <span className="more" title={typeof value.more === 'string' ? value.more : undefined}>
            · {value.more}
          </span>
        ) : null}
      </>
    );
    return value.href ? (
      <a className="ps" href={value.href}>
        {body}
      </a>
    ) : (
      <span className="ps">{body}</span>
    );
  };
  return (
    <nav className="pstate" aria-label="Where the project stands">
      {of === 'app' && ticks ? (
        <span
          className="roll"
          role="img"
          aria-label={`Items in this project: ${amount(done.n, done.atLeast)} of ${total.toLocaleString()} done, ${amount(inProgress.n, inProgress.atLeast)} in progress, ${amount(left.n, left.atLeast)} left`}
        >
          {Array.from({ length: ticks }, (_, i) => (
            <i
              key={i}
              className={i * step < done.n ? 'ok' : i * step < done.n + inProgress.n ? 'run' : undefined}
            />
          ))}
        </span>
      ) : null}
      {cell('Done', 'passed', 'passed', done, units.done)}
      {cell('In progress', 'active', 'active', inProgress, units.inProgress)}
      {cell('Left', 'stale', 'planned', left, units.left)}
    </nav>
  );
}
