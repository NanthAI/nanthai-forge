// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What the last Loose ends action did (Item fc1831eb), as the approved forge-design-p7/flow/loose-ends.html says it.
// When some rows were left alone, the waiting notice names each with why, offers Retry for the calls that failed
// only, See what is left, and Undo for the rows the action did change. When every row changed, a toast says so with
// Undo. A toast for a copied prompt has no Undo: nothing changed. Nothing here reads or polls.
import { useEffect, useState } from 'react';
import { Key, State } from '../../ds';

export type LeftAlone = {
  /** "2 could not be set aside". */
  head: string;
  /** "1 Lane was set aside in your last try. " or "". */
  lead: string;
  named: string[];
  more: number;
  failed: number;
  skipped: number;
};

export function ResultNotice({
  left,
  busy,
  onRetry,
  onSeeLeft,
  onUndo,
}: {
  left: LeftAlone;
  busy: boolean;
  onRetry: () => void;
  /** Names every row left alone; null once they all are. */
  onSeeLeft: (() => void) | null;
  onUndo: (() => void) | null;
}) {
  return (
    <div className="notice" data-st="waiting" role="alert">
      <State word="Needs you">{left.head}</State>
      <p>
        {left.lead}
        {left.named.join('; ')}
        {left.more ? `; and ${left.more.toLocaleString('en')} more` : ''}. Every save is kept.
      </p>
      {left.failed ? (
        <Key size="sm" kind="rec" disabled={busy} onClick={onRetry}>
          Retry {left.failed.toLocaleString('en')} that failed
        </Key>
      ) : null}
      {left.skipped && onSeeLeft ? (
        <Key size="sm" onClick={onSeeLeft}>
          See what is left
        </Key>
      ) : null}
      {onUndo ? (
        <Key size="sm" kind="ghost" disabled={busy} onClick={onUndo}>
          Undo
        </Key>
      ) : null}
    </div>
  );
}

export type Toast = { text: string; undo: (() => void) | null };

/** One toast at a time. It leaves after 10 s unless focused (one timer per toast shown, none while idle). */
export function ResultToast({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focused) return;
    const timer = setTimeout(onDone, 10_000);
    return () => clearTimeout(timer);
  }, [focused, toast, onDone]);
  return (
    <div className="toasts" role="status">
      <div
        className="toast"
        onFocus={() => setFocused(true)}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <span>{toast.text}</span>
        {toast.undo ? (
          <button type="button" onClick={toast.undo}>
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
