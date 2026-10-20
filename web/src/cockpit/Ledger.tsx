// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { Avatar, DiffStat, Panel } from '../ui/primitives';
import { AutoTag, Tooltip } from '../ui/signals';
import { age } from '../ui/status';
import { duration, startOfDay, type AcceptedRow } from './now-model';

const DAY_ROWS = 5;
const DAY_MS = 86_400_000;

function dayLabel(day: number, today: number): string {
  if (day === today) return 'Today';
  if (day === startOfDay(today - DAY_MS / 2)) return 'Yesterday';
  return new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Acceptances grouped by local day, newest first. */
export function acceptedDays(rows: readonly AcceptedRow[], now: number) {
  const today = startOfDay(now);
  const days = new Map<number, AcceptedRow[]>();
  for (const row of [...rows].sort((a, b) => b.at.localeCompare(a.at))) {
    const day = startOfDay(Date.parse(row.at));
    days.set(day, [...(days.get(day) ?? []), row]);
  }
  return [...days].map(([day, acceptances]) => ({
    day,
    label: dayLabel(day, today),
    today: day === today,
    rows: acceptances,
  }));
}

/**
 * Accepted: the one place for work that reached main, full width under the three cards. Today is
 * open; earlier days are collapsed bands. Each row: what landed, its Intent, who accepted, the check
 * that let it in, the diff and when.
 */
export function Ledger({
  rows,
  now,
  laneHref,
  viewHref,
  historyHref,
  empty,
}: {
  rows: readonly AcceptedRow[];
  now: number;
  laneHref: (laneId: string) => string;
  /** Where an acceptance's View opens; falls back to its first Lane. */
  viewHref?: (viewId: string) => string;
  historyHref?: string;
  /** Shown instead of hiding the section when nothing was accepted. */
  empty?: string;
}) {
  const days = acceptedDays(rows, now);
  const today = days.find(day => day.today)?.rows.length ?? 0;
  if (days.length === 0)
    return empty ? (
      <Panel title="Accepted" labelId="fx-accepted-title" className="fx-ledger">
        <div className="fx-allclear">
          <span className="fx-muted">{empty}</span>
        </div>
      </Panel>
    ) : null;
  return (
    <Panel
      title="Accepted"
      labelId="fx-accepted-title"
      count={today ? `${today} today` : undefined}
      className="fx-ledger"
      actions={historyHref && <a href={historyHref}>Full history</a>}
    >
      <div className="fx-ledger-h" aria-hidden="true">
        <span />
        <span>What landed on main</span>
        <span>Intent</span>
        <span>Who accepted</span>
        <span>Check</span>
        <span>Diff</span>
        <span>When</span>
      </div>
      {days.map(day => (
        <Day key={day.day} {...day} now={now} laneHref={laneHref} viewHref={viewHref} />
      ))}
    </Panel>
  );
}

function Day({
  label,
  today,
  rows,
  now,
  laneHref,
  viewHref,
}: {
  label: string;
  today: boolean;
  rows: readonly AcceptedRow[];
  now: number;
  laneHref: (laneId: string) => string;
  viewHref?: (viewId: string) => string;
}) {
  const [open, setOpen] = useState(today);
  const [all, setAll] = useState(false);
  const total = rows.every(row => row.diff)
    ? rows.reduce((sum, row) => ({ add: sum.add + row.diff!.add, del: sum.del + row.diff!.del }), {
        add: 0,
        del: 0,
      })
    : null;
  const intents = new Set(rows.flatMap(row => (row.intentId ? [row.intentId] : []))).size;
  const shown = all ? rows : rows.slice(0, DAY_ROWS);
  return (
    <>
      <div className="fx-ledger-day">
        <b>{label}</b> · {rows.length}
        {total && <DiffStat add={total.add} del={total.del} />}
        {intents > 0 && (
          <span className="fx-faint">
            · {intents} {intents === 1 ? 'Intent' : 'Intents'}
          </span>
        )}
        {!today && (
          <button
            type="button"
            className="fx-ledger-show"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {open && (
        <>
          <ul className="fx-ledger-rows">
            {shown.map(row => (
              <Acceptance
                key={row.id}
                row={row}
                now={now}
                undo={today}
                laneHref={laneHref}
                viewHref={viewHref}
              />
            ))}
          </ul>
          {rows.length > DAY_ROWS && (
            <button type="button" className="fx-fold" aria-expanded={all} onClick={() => setAll(!all)}>
              {all
                ? 'Show fewer'
                : `${rows.length - DAY_ROWS} more ${today ? 'today' : label === 'Yesterday' ? 'yesterday' : ''}`.trim()}
            </button>
          )}
        </>
      )}
    </>
  );
}

function Acceptance({
  row,
  now,
  undo,
  laneHref,
  viewHref,
}: {
  row: AcceptedRow;
  now: number;
  /** Today's automatic acceptances show how to undo them. */
  undo: boolean;
  laneHref: (laneId: string) => string;
  viewHref?: (viewId: string) => string;
}) {
  const href = viewHref ? viewHref(row.viewId) : row.laneId ? laneHref(row.laneId) : undefined;
  const detail = row.automatic
    ? [row.by, row.automatic.summary, row.automatic.undo].filter(Boolean).join('. ')
    : undefined;
  return (
    <li className="fx-ledger-r">
      <Glyph name="passed" size={12} />
      <div className="fx-ledger-what">
        {href ? <a href={href}>{row.title}</a> : <span>{row.title}</span>}
        {(row.laneCount || (undo && row.automatic?.undo)) && (
          <small>
            {row.laneCount && (
              <>
                <Glyph name="lane" size={11} />
                Candidate of {row.laneCount} {row.laneCount === 1 ? 'Lane' : 'Lanes'}
              </>
            )}
            {undo && row.automatic?.undo && (
              <>
                {row.laneCount && <span aria-hidden="true">·</span>}
                <UndoTip text={row.automatic.undo} />
              </>
            )}
          </small>
        )}
      </div>
      <div className="fx-ledger-intent">
        {row.intentTitle && (
          <>
            <Glyph name="intent" size={11} />
            <span title={row.intentTitle}>{row.intentTitle}</span>
          </>
        )}
      </div>
      <div className="fx-ledger-who" title={detail}>
        {row.by && (
          <>
            <Avatar name={row.by} kind={row.byAgent || row.automatic ? 'agent' : 'human'} size="sm" />
            <span className="fx-ledger-n">{row.by}</span>
          </>
        )}
        {row.automatic && <AutoTag />}
      </div>
      <div className="fx-ledger-check">
        {row.checkMs !== undefined && (
          <>
            <Glyph name="check" size={12} />
            <span>
              {row.checkName ?? 'check'} · {duration(row.checkMs)}
            </span>
          </>
        )}
      </div>
      <div className="fx-ledger-diff">{row.diff && <DiffStat add={row.diff.add} del={row.diff.del} />}</div>
      <div className="fx-ledger-when">{age(row.at, now)}</div>
    </li>
  );
}

/** Undo for an automatic acceptance: the recorded way back, on tap or hover. */
function UndoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip className="fx-ledger-undo" open={open} content={text}>
      {id => (
        <button
          type="button"
          className="fx-undo"
          aria-describedby={id}
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          onBlur={() => setOpen(false)}
        >
          Undo
        </button>
      )}
    </Tooltip>
  );
}
