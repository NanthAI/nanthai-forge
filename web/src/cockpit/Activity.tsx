// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { activityBursts } from './activity-groups';
import type { FeedItem } from './attention';
import { Button, Segmented } from '../ui/primitives';

const kinds = ['All', 'Accepted', 'Checks', 'Messages', 'Claims', 'Handoffs', 'Saves'] as const;
type Kind = (typeof kinds)[number];
const matches = (item: FeedItem, kind: Kind) =>
  kind === 'All' ||
  {
    Accepted: item.glyph === 'channel',
    Checks: item.id.startsWith('run:'),
    Messages: item.glyph === 'message',
    Claims: item.glyph === 'claim',
    Handoffs: item.glyph === 'handoff',
    Saves: item.id.startsWith('save:'),
  }[kind];

/** Activity records what happened; pending decisions remain in Now's Needs you panel. */
export function Activity({
  items,
  paging,
  decisions,
  nowHref,
  laneHref,
  viewHref,
  complete = true,
  loading = false,
  loadMore,
}: {
  complete?: boolean;
  loading?: boolean;
  loadMore?: (() => void) | undefined;
  items: readonly FeedItem[];
  paging?: { more: boolean; loading: boolean; loadMore: () => void };
  decisions: number;
  now: number;
  nowHref: string;
  laneHref: (id: string) => string;
  viewHref: (id: string) => string;
}) {
  const hasMore = paging?.more ?? !complete;
  const loadingHistory = paging?.loading ?? loading;
  const loadHistory = paging?.loadMore ?? loadMore;
  const [limit, setLimit] = useState(60);
  const [kind, setKind] = useState<Kind>('All');
  const [query, setQuery] = useState('');
  const visible = items.filter(
    item =>
      matches(item, kind) && `${item.text} ${item.detail ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = new Map<string, FeedItem[]>();
  for (const item of visible.slice(0, limit)) {
    const date = new Date(item.at).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    groups.set(date, [...(groups.get(date) ?? []), item]);
  }
  const eventRow = (item: FeedItem) => (
    <li key={item.id} className="fx-activity-event">
      <time dateTime={new Date(item.at).toISOString()}>
        {new Date(item.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
      <span className={`fx-fact-${item.tone}`}>
        <Glyph name={item.glyph} size={15} />
      </span>
      <div>
        {item.laneId ? <a href={laneHref(item.laneId)}>{item.text}</a> : item.text}
        {item.detail?.replace(/\b[0-9a-f]{7,64}\b\s*[·:]?\s*/gi, '').trim() && (
          <small>{item.detail.replace(/\b[0-9a-f]{7,64}\b\s*[·:]?\s*/gi, '').trim()}</small>
        )}
        {item.laterViewId && (
          <a className="fx-feed-detail" href={viewHref(item.laterViewId)}>
            Later View
          </a>
        )}
      </div>
    </li>
  );
  return (
    <div className="fx-page fx-activity">
      <header className="fx-activity-head">
        <div>
          <div className="fx-faint">
            <a href={nowHref}>History</a>
          </div>
          <h1>Activity</h1>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = 'forge-activity.json';
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          {hasMore ? 'Export loaded' : 'Export'}
        </Button>
      </header>
      <div className="fx-activity-filters">
        <Segmented
          label="Activity kind"
          value={kind}
          options={kinds.map(value => ({ id: value, label: value }))}
          onChange={value => {
            setKind(value);
            setLimit(60);
          }}
        />
        <input
          type="search"
          aria-label="Find activity"
          placeholder="Path or text"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setLimit(60);
          }}
        />
      </div>
      {decisions > 0 && (
        <div className="fx-fold">
          {decisions} waiting for your decision · <a href={`${nowHref}#fx-needs-title`}>in Needs you</a>
        </div>
      )}
      <div className="fx-activity-layout">
        <div className="fx-activity-days">
          {[...groups].map(([day, rows], index) => (
            <section className="fx-activity-day" id={`activity-day-${index}`} key={day}>
              <header>
                <h2>{day}</h2>
                <span>{rows.length} events</span>
              </header>
              {activityBursts(rows).map(burst =>
                burst.length === 1 ? (
                  <ol key={burst[0]!.id}>{eventRow(burst[0]!)}</ol>
                ) : (
                  <details className="fx-activity-burst" key={burst[0]!.id}>
                    <summary>
                      <Glyph name="file" size={15} />
                      <span>
                        {burst.length} saves · {burst[0]!.text}
                      </span>
                    </summary>
                    <ol>{burst.map(eventRow)}</ol>
                  </details>
                ),
              )}
            </section>
          ))}
          {!groups.size && (
            <p className="fx-activity-empty">{items.length ? 'No matching events.' : 'No activity yet.'}</p>
          )}
          <footer className="fx-activity-pagination">
            <span>
              Showing {visible.length ? 1 : 0}–{Math.min(limit, visible.length)} of {visible.length} loaded
              events{hasMore ? ' · more history available' : ''}
            </span>
            {limit < visible.length && (
              <Button variant="ghost" onClick={() => setLimit(value => value + 60)}>
                Show more
              </Button>
            )}
            {hasMore && loadHistory && (
              <Button variant="ghost" disabled={loadingHistory} onClick={loadHistory}>
                {loadingHistory ? 'Loading history…' : 'Load older activity'}
              </Button>
            )}
          </footer>
        </div>
        <nav className="fx-activity-jump" aria-label="Jump to day">
          <strong>Jump</strong>
          {[...groups.keys()].map((day, index) => (
            <a key={day} href={`#activity-day-${index}`}>
              {day}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}
