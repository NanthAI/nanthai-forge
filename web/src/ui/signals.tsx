import { useToast } from './Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Glyph } from './Glyph';

/** Marks something Forge did without a person. Always sits next to what it did. */
export function AutoTag() {
  return (
    <span className="fx-auto" title="Done automatically under this project's autonomy setting">
      auto
    </span>
  );
}

/**
 * The undo slot beside an automatic action. With a handler it is a link-style button; without one
 * it says why there is nothing to undo, so the slot never silently disappears.
 */
export function Undo({
  onUndo,
  busy = false,
  reason = 'Nothing to undo.',
  label = 'Undo',
}: {
  onUndo?: () => void;
  busy?: boolean;
  reason?: string;
  label?: string;
}) {
  if (!onUndo) return <span className="fx-undo-none">{reason}</span>;
  return (
    <button type="button" className="fx-undo" onClick={onUndo} disabled={busy}>
      {busy ? 'Undoing…' : label}
    </button>
  );
}

/**
 * The (i) affordance: an explanation that used to be permanent text, shown on hover, focus or tap.
 * `inline` is the 18px variant for use inside a sentence.
 */
export function InfoTip({
  label,
  children,
  inline = false,
}: {
  label: string;
  children: ReactNode;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip className={inline ? 'fx-info fx-info-inline' : 'fx-info'} open={open} content={children}>
      {id => (
        <button
          type="button"
          aria-label={label}
          aria-describedby={id}
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          onBlur={() => setOpen(false)}
          onKeyDown={event => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <Glyph name="info" size={inline ? 12 : 14} />
        </button>
      )}
    </Tooltip>
  );
}

/** A count badge. `hot` is reserved for the Needs-you count and turns neutral at zero. */
export function CountPill({ count, hot = false, label }: { count: number; hot?: boolean; label?: string }) {
  return (
    <span className={hot && count > 0 ? 'fx-count fx-count-hot' : 'fx-count'} aria-label={label}>
      {count}
    </span>
  );
}

/**
 * The one sentence under a page title: the leading clause carries the news, counts inside are
 * links to the panels they summarise.
 */
export function Situation({ lead, children }: { lead: ReactNode; children?: ReactNode }) {
  return (
    <p className="fx-situation">
      <b>{lead}</b>
      {children && <> {children}</>}
    </p>
  );
}

export type Accepted = {
  /** What was accepted, usually the Lane or Intent name. */
  title: string;
  channel?: string;
  add?: number;
  del?: number;
  /** One consequence, e.g. "2 Lanes will update". */
  follow?: string;
  onUndo?: () => void;
};

/** The celebration: a quiet toast that rises once and leaves after six seconds. */
export function AcceptedToast({
  accepted,
  onClose,
  timeoutMs = 6000,
}: {
  accepted: Accepted | null;
  onClose: () => void;
  timeoutMs?: number;
}) {
  const toast = useToast();
  useEffect(() => {
    if (!accepted) return;
    const { title, channel = 'main', add, del, follow, onUndo } = accepted;
    const message = `Accepted into ${channel} · ${title}${add !== undefined && del !== undefined ? ` · +${add.toLocaleString()} −${del.toLocaleString()}` : ''}${follow ? ` · ${follow}` : ''}`;
    toast.show({
      message,
      tone: 'success',
      ...(onUndo
        ? {
            action: (
              <button type="button" className="fx-btn fx-btn-secondary fx-btn-sm" onClick={onUndo}>
                Undo
              </button>
            ),
          }
        : {}),
    });
    const timer = setTimeout(onClose, timeoutMs);
    return () => clearTimeout(timer);
  }, [accepted, onClose, timeoutMs, toast]);
  return null;
}

/** Shared tooltip surface for a caller-owned focusable trigger, including linked markers. */
export function Tooltip({
  children,
  content,
  placement = 'below',
  offset,
  className = '',
  open = false,
}: {
  children: (id: string) => ReactNode;
  content: ReactNode;
  placement?: 'above' | 'below';
  offset?: number;
  className?: string;
  open?: boolean;
}) {
  const id = useId();
  return (
    <span
      className={`fx-tooltip ${className}`.trim()}
      data-placement={placement}
      data-open={open || undefined}
    >
      {children(id)}
      <span
        role="tooltip"
        id={id}
        className="fx-info-tip"
        style={offset === undefined ? undefined : { left: offset, right: 'auto' }}
      >
        {content}
      </span>
    </span>
  );
}
