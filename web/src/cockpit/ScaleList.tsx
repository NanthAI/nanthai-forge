// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Dot } from '../ui/primitives';
import type { Tone } from '../ui/status';
import { Button } from '../ui/primitives';
import { SCALE_AFTER, SCALE_PAGE } from './scale-model';
import './scale.css';

/** UI pagination over a complete observed list; every row remains reachable. */
export function PagedList<T>({
  rows,
  render,
  className = 'fx-scale-list',
  label = 'items',
  size = SCALE_AFTER,
}: {
  rows: readonly T[];
  render: (row: T) => ReactNode;
  className?: string;
  label?: string;
  size?: number;
}) {
  const [limit, setLimit] = useState(size);
  return (
    <>
      <ul className={className}>{rows.slice(0, limit).map(render)}</ul>
      {rows.length > limit && (
        <div className="fx-scale-more">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Show ${Math.min(size, rows.length - limit)} more ${label}`}
            onClick={() => setLimit(limit + size)}
          >
            Show {Math.min(size, rows.length - limit)} more · {rows.length - limit} remaining
          </Button>
        </div>
      )}
    </>
  );
}

/** Collapsed groups mount their rows only when opened, retaining existing per-item actions. */
export function ScaleGroups<T>({
  groups,
  render,
  className,
  noun,
  summary,
  openFirst = false,
}: {
  openFirst?: boolean;
  groups: readonly { id: string; title: string; rows: readonly T[] }[];
  render: (row: T) => ReactNode;
  className?: string;
  noun: string;
  summary?: (rows: readonly T[]) => ReactNode;
}) {
  return (
    <div className="fx-scale-groups">
      <PagedList
        label={`${noun} groups`}
        rows={groups}
        size={SCALE_PAGE}
        render={group => (
          <li key={group.id}>
            <ScaleGroup
              initiallyOpen={openFirst && group.id === groups[0]?.id}
              title={group.title}
              rows={group.rows}
              render={render}
              className={className}
              noun={noun}
              summary={summary}
            />
          </li>
        )}
      />
    </div>
  );
}
function ScaleGroup<T>({
  initiallyOpen,
  title,
  rows,
  render,
  className,
  noun,
  summary,
}: {
  initiallyOpen?: boolean;
  title: string;
  rows: readonly T[];
  render: (row: T) => ReactNode;
  className?: string;
  noun: string;
  summary?: (rows: readonly T[]) => ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen ?? false);
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="fx-scale-heading">
          <span className="fx-scale-chevron" aria-hidden="true">
            ▸
          </span>
          <span className="fx-scale-title" title={title}>
            {title}
          </span>
          <span className="fx-count" title={`${rows.length} ${rows.length === 1 ? noun : `${noun}s`}`}>
            {rows.length}
          </span>
        </span>
        {summary && <span className="fx-scale-summary">{summary(rows)}</span>}
      </summary>
      {open && (
        <PagedList
          label={`${noun}s in ${title}`}
          rows={rows}
          render={render}
          className={className}
          size={SCALE_PAGE}
        />
      )}
    </details>
  );
}

/** Printed counts retain status words and glyphs in either theme. */
export function ScaleStatusCounts({ rows }: { rows: readonly { label: string; tone: Tone }[] }) {
  const counts = new Map<string, { count: number; tone: Tone }>();
  for (const row of rows)
    counts.set(row.label, { count: (counts.get(row.label)?.count ?? 0) + 1, tone: row.tone });
  return (
    <>
      {[...counts].map(([label, value]) => (
        <span className="fx-scale-status" key={label}>
          <Dot tone={value.tone} />
          {value.count} {label}
        </span>
      ))}
    </>
  );
}
