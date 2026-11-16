// SPDX-License-Identifier: Apache-2.0
// The line's slot in the top bar (Item 18af654d owns the marks, their motion and the feed). The frame draws the stops
// and their counts from the feed's shared contract (convex/projectLiveLine.ts `liveLineResult`); until the feed
// arrives it draws the stops with no counts, so nothing moves when it does. Each stop links to Lanes at that stop.
import { hrefFor } from './paths';
import { followLink } from './router';

export type LineStage = 'editing' | 'saved' | 'checking' | 'ready';
/** The feed's shape (liveLineResult), restated so the frame does not import Convex server code. */
export type LineFeed = {
  lanes: readonly { laneId: string; stage: LineStage; held: boolean; overlap: boolean; changedAt: number }[];
  more: number;
  moreIsLowerBound: boolean;
  main: { head: string; at?: string } | null;
  /** The last Lane that left the line, and how. */
  exit?: { laneId: string; kind: 'landed' | 'set-aside'; at: number } | null;
};

const stops: readonly { stage: LineStage; label: string; short: string }[] = [
  { stage: 'editing', label: 'Editing', short: 'Edit' },
  { stage: 'saved', label: 'Saved', short: 'Saved' },
  { stage: 'checking', label: 'Checking', short: 'Check' },
  { stage: 'ready', label: 'Ready to land', short: 'Ready' },
];

/** What waits on a person: every held Lane in the feed. The count beside "Needs you" and on the rail. */
export function heldCount(feed: LineFeed | undefined) {
  return feed ? feed.lanes.filter(lane => lane.held).length : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function Line({
  feed,
  handle,
  project,
  phone = false,
}: {
  feed: LineFeed | undefined;
  handle: string;
  project: string;
  phone?: boolean;
}) {
  const lanesHref = hrefFor({ frame: 'project', handle, project, place: 'lanes', section: '', rest: '' });
  return (
    <nav
      className={phone ? 'line phone' : 'line'}
      aria-label="Where work is"
      aria-busy={feed ? undefined : true}
    >
      {stops.map(stop => {
        const at = feed?.lanes.filter(lane => lane.stage === stop.stage) ?? [];
        const held = at.filter(lane => lane.held).length;
        const words = feed
          ? `${plural(at.length, 'Lane')} ${stop.label.toLowerCase()}${held ? `, ${held} held` : ''}`
          : `${stop.label}, not loaded yet`;
        return (
          <a
            key={stop.stage}
            href={`${lanesHref}?stop=${stop.stage}`}
            onClick={followLink}
            className={feed && !at.length ? 'stop zero' : 'stop'}
            data-stop={stop.stage}
            aria-label={words}
          >
            <span className="lbl" aria-hidden="true">
              {phone ? stop.short : stop.label}
            </span>
            <span className="slot" aria-hidden="true" />
            {feed ? (
              <span className="n" aria-hidden="true">
                {at.length}
              </span>
            ) : null}
          </a>
        );
      })}
      <a
        href={hrefFor({ frame: 'project', handle, project, place: 'code', section: '', rest: '' })}
        onClick={followLink}
        className="stop tomain"
        aria-label={feed?.main ? 'main' : 'main, nothing landed yet'}
      >
        <span className="lbl" aria-hidden="true">
          main
        </span>
      </a>
    </nav>
  );
}
