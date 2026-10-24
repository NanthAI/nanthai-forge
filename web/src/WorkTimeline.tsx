// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
export type TimelineEntry = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail?: ReactNode;
  status?: string;
  href?: string;
  open?: () => void;
};
export function WorkTimeline({
  entries,
  loading = false,
  label = 'Work history',
}: {
  entries: TimelineEntry[];
  loading?: boolean;
  label?: string;
}) {
  const [kind, setKind] = useState('all'),
    [order, setOrder] = useState('newest');
  const kinds = [...new Set(entries.map(entry => entry.kind))];
  const visible = entries
    .filter(entry => kind === 'all' || entry.kind === kind)
    .sort((a, b) => (order === 'newest' ? -1 : 1) * a.at.localeCompare(b.at));
  const icons: Record<string, IconName> = {
    Completed: 'check',
    Reopened: 'activity',
    Created: 'plus',
    Checkpoint: 'code',
    View: 'view',
    Accepted: 'channel',
    Decision: 'review',
  };
  return (
    <section className="work-timeline" aria-label={label}>
      <div className="timeline-toolbar">
        <strong>{label}</strong>
        <label>
          Events
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="all">All events</option>
            {kinds.map(value => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Order
          <select value={order} onChange={e => setOrder(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>
      {loading && <p role="status">Loading history…</p>}
      <ol>
        {visible.map((entry, index) => (
          <li key={entry.id}>
            <span
              className={`timeline-dot tone-${entry.kind === 'Completed' ? 'success' : entry.kind === 'Reopened' ? 'info' : 'muted'}`}
            >
              <Icon name={icons[entry.kind] ?? 'clock'} />
            </span>
            <div>
              {(!index ||
                new Date(visible[index - 1]!.at).toDateString() !== new Date(entry.at).toDateString()) && (
                <p className="timeline-date">
                  {new Date(entry.at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              )}
              <div className="timeline-event-heading">
                {entry.href ? (
                  <a href={entry.href}>{entry.title}</a>
                ) : entry.open ? (
                  <button className="text-action" onClick={entry.open}>
                    {entry.title}
                  </button>
                ) : (
                  <strong>{entry.title}</strong>
                )}
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              {entry.detail && <div className="timeline-detail">{entry.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      {!loading && !visible.length && <p>No events in this view.</p>}
    </section>
  );
}
