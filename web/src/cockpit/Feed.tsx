// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { Empty, Panel } from '../ui/primitives';
import { age } from '../ui/status';
import type { FeedItem } from './attention';

/** Recent related changes, newest first. Times are observed record times. */
export function Feed({
  title = 'Recent changes',
  items,
  now,
  scope,
  footer,
  laneHref,
  actions,
  viewHref,
}: {
  title?: string;
  items: readonly FeedItem[];
  now: number;
  scope?: string;
  footer?: ReactNode;
  actions?: ReactNode;
  laneHref?: (laneId: string) => string;
  viewHref?: (viewId: string) => string;
}) {
  return (
    <Panel
      title={title}
      actions={
        <>
          {scope && <span className="fx-faint">{scope}</span>}
          {actions}
        </>
      }
      footer={footer}
    >
      {items.length === 0 ? (
        <Empty glyph="now" title="No activity yet" />
      ) : (
        <ol className="fx-feed">
          {[...items]
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
            .map(item => (
              <li key={item.id}>
                <span className="fx-feed-time">{age(item.at, now)}</span>
                <span className={`fx-feed-glyph fx-fact-${item.tone}`}>
                  <Glyph name={item.glyph} size={12} />
                </span>
                <span className="fx-feed-text">
                  {item.laneId && laneHref ? <a href={laneHref(item.laneId)}>{item.text}</a> : item.text}
                  {item.laterViewId && viewHref && (
                    <a className="fx-feed-detail" href={viewHref(item.laterViewId)}>
                      Later Candidate
                    </a>
                  )}
                  {item.detail && <span className="fx-feed-detail">{item.detail}</span>}
                </span>
              </li>
            ))}
        </ol>
      )}
    </Panel>
  );
}
